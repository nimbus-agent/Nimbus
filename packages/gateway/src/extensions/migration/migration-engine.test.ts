/**
 * The migration state machine (Readwise unbundling spec § 7.2): evaluate → prepare (fetch, verify,
 * stage, pause) → one `extension.migrate` prompt → install + grant + register + resume.
 *
 * Every test uses a FIXTURE continuity entry whose legacy id (`fixture_reader`) is not a bundled
 * connector (ruling B3): while bundled Readwise is compiled in, the engine skips `readwise`
 * entirely. The test names the plan gave in Readwise terms are kept, and made true for the fixture.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import pino from "pino";

import { listExtensions } from "../../automation/extension-store.ts";
import { createExtensionCredentialsResolver } from "../../connectors/extension-sync/extension-identity.ts";
import { getConnectorHealth, transitionHealth } from "../../connectors/health.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { createExtensionSyncRegistrar } from "../../platform/register-extension-sync.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { SyncScheduler } from "../../sync/scheduler.ts";
import { loadSchedulerState, setPaused } from "../../sync/scheduler-store.ts";
import { unboundSyncCapabilities } from "../../sync/sync-capabilities.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ContinuityEntry } from "../continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "../extension-run-grants.ts";
import { resolveExtensionManifestPath } from "../manifest.ts";
import { buildTestRegistry } from "../registry/__fixtures__/build-test-registry.ts";
import type { BuiltinRegistryConfig } from "../registry/builtin-registry.ts";
import { installVerifiedRegistryPackage } from "../registry/install-from-registry.ts";
import { getRunGrant } from "../run-grant-store.ts";
import { computeExtensionTreeDigest } from "../tree-digest.ts";
import {
  awaitingApprovalReason,
  createMigrationEngine,
  type MigrationConsentPayload,
  type MigrationEngine,
  type MigrationEngineDeps,
  pauseLegacyService,
} from "./migration-engine.ts";
import {
  finishMigration,
  getMigration,
  listMigrations,
  recordMigrationPrepared,
} from "./migration-store.ts";

const EXT = "com.example.reader";
const LEGACY = "fixture_reader";
const LEGACY_KEY = "fixture_reader.token";
const TOKEN = "SECRET-TOKEN-VALUE-0123456789";
const HOST = "reader.example";
const BUILTIN_URL = "https://registry.nimbus.test/";
/** PR 4 R7: the bytes a bundled-style Readwise scheduler row stores (ruling B4). */
const SEEDED_CURSOR = "nimbus-readwise1:eyJwYXNzIjoxfQ";
const NOW = Date.parse("2026-10-20T12:00:00Z");

const MANIFEST_EXTRA = {
  name: "Fixture Reader",
  permissions: { network: [HOST] },
  credentials: { token: { env: "FIXTURE_TOKEN" } },
  sync: { contract: "1", intervalSeconds: 600, itemTypes: ["highlight", "book"] },
};

let tmp: string;
let registryDir: string;
let builtin: BuiltinRegistryConfig;
let entry: ContinuityEntry;
let db: Database;
let vault: NimbusVault;
let offline: boolean;
let fetches: string[];
let resumed: string[];
let refreshed: string[];
let logs: unknown[];
/** The fake scheduler's registrations: service id -> extension id. */
let registered: Map<string, string>;
/** Where the fake registrar registers a live, granted extension's sync. */
let registerMode: "legacy" | "none" | "ext";
const CODE_ID = "ext_com_example_reader";
const extraCleanups: Array<() => Promise<void> | void> = [];

async function buildRegistry(extra: Record<string, unknown> = MANIFEST_EXTRA): Promise<void> {
  rmSync(registryDir, { recursive: true, force: true });
  const built = await buildTestRegistry(registryDir, {
    id: EXT,
    versions: [{ version: "1.0.0" }],
    publisherId: "nimbus",
    manifestExtra: extra,
  });
  builtin = { url: BUILTIN_URL, rootKey: built.rootKey };
  entry = {
    legacyServiceId: LEGACY,
    extensionId: EXT,
    publisherKey: built.publisherKey,
    sourceRootFingerprint: publisherKeyFingerprint(built.rootKey),
    credentials: { token: LEGACY_KEY },
    expectedPermissions: { network: [HOST], read: [], write: [] },
    itemTypes: ["highlight", "book"],
    displayName: "Fixture Reader",
  };
}

beforeEach(async () => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-migration-")));
  registryDir = join(tmp, "official");
  await buildRegistry();
  db = openMemoryIndexDatabase();
  vault = createMemoryVault();
  await vault.set(LEGACY_KEY, TOKEN);
  offline = false;
  fetches = [];
  resumed = [];
  refreshed = [];
  logs = [];
  registered = new Map();
  registerMode = "legacy";
});

afterEach(async () => {
  for (const c of extraCleanups.splice(0).reverse()) await c();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function grantEnv(platform: NodeJS.Platform = process.platform): ExtensionRunGrantEnv {
  return {
    platform,
    protectedRoots: [join(tmp, "data"), join(tmp, "config")],
    runtimeReadPaths: [join(tmp, "bun-bin")],
    realpath: (p) => realpathSync.native(p),
  };
}

function deps(over: Partial<MigrationEngineDeps> = {}): MigrationEngineDeps {
  return {
    db,
    vault,
    dataDir: join(tmp, "data"),
    extensionsDir: join(tmp, "data", "extensions"),
    fetch: {
      fetchFn: async (url) => {
        fetches.push(url);
        if (offline) throw new Error("getaddrinfo ENOTFOUND registry.nimbus.test");
        const u = new URL(url);
        try {
          return new Response(
            readFileSync(join(registryDir, ...u.pathname.split("/").filter(Boolean))),
          );
        } catch {
          return new Response("missing", { status: 404 });
        }
      },
      enforceAirGap: () => false,
      now: () => NOW,
      production: false,
    },
    builtin,
    continuityTable: [entry],
    isBundledConnector: () => false,
    env: grantEnv(),
    runtimeEnabled: true,
    sandbox: { canConfine: () => null },
    extensionSync: {
      // Mirrors the real registrar's contract: (re)register a live, granted extension, else
      // unregister whatever it registered.
      refresh: (id) => {
        refreshed.push(id);
        for (const [k, v] of registered) if (v === id) registered.delete(k);
        const live = listExtensions(db).some((r) => r.id === id) && getRunGrant(db, id) !== null;
        if (!live || registerMode === "none") return;
        registered.set(registerMode === "legacy" ? LEGACY : CODE_ID, id);
      },
    },
    scheduler: {
      resume: (id) => {
        resumed.push(id);
        setPaused(db, id, false);
        transitionHealth(db, id, { type: "resumed" });
      },
      syncableFor: (id) => registered.get(id),
    },
    now: () => NOW,
    logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
    ...over,
  };
}

function engine(over: Partial<MigrationEngineDeps> = {}): MigrationEngine {
  return createMigrationEngine(deps(over));
}

function consentThat(answer: boolean, seen: MigrationConsentPayload[]) {
  return async (p: MigrationConsentPayload): Promise<boolean> => {
    seen.push(p);
    return answer;
  };
}

function onlyRow() {
  const rows = listMigrations(db);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("premise: one migration row");
  return row;
}

function stageRootOf(id: string): string {
  return join(tmp, "data", "migrations", id);
}

describe("evaluate", () => {
  test("no readwise.token -> no row, no fetch", async () => {
    await vault.delete(LEGACY_KEY);
    await engine().evaluate();
    await vault.set(LEGACY_KEY, "   ");
    await engine().evaluate();
    expect(listMigrations(db)).toEqual([]);
    expect(fetches).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)).toBeNull();
  });

  test("production defaults (no built-in registry, empty continuity table) are a no-op", async () => {
    const { builtin: _b, continuityTable: _t, ...rest } = deps();
    await createMigrationEngine(rest).evaluate();
    await createMigrationEngine({ ...rest, builtin: null }).evaluate();
    expect(listMigrations(db)).toEqual([]);
    expect(fetches).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)).toBeNull();
    expect(getConnectorHealth(db, LEGACY).state).toBe("not_configured");
  });

  test("a legacy id whose bundled connector is still compiled in is skipped: no row, no fetch, no pause", async () => {
    await engine({ isBundledConnector: (id) => id === LEGACY }).evaluate();
    expect(listMigrations(db)).toEqual([]);
    expect(fetches).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)).toBeNull();
    expect(JSON.stringify(logs)).toContain("bundled");
  });

  test("the default bundled predicate is the real bundled registry: a readwise entry is skipped", async () => {
    const { isBundledConnector: _p, ...rest } = deps();
    await createMigrationEngine({
      ...rest,
      continuityTable: [{ ...entry, legacyServiceId: "readwise" }],
    }).evaluate();
    expect(listMigrations(db)).toEqual([]);
    expect(fetches).toEqual([]);
  });

  test("prepare stages the verified package, writes no extension row, and pauses the legacy service", async () => {
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("awaiting_approval");
    expect(row.version).toBe("1.0.0");
    expect(row.treeDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.stagePath?.startsWith(stageRootOf(row.id))).toBe(true);
    expect(existsSync(row.stagePath ?? "")).toBe(true);
    expect(listExtensions(db)).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toBe(
      `Fixture Reader moved to an extension — run \`nimbus connector migrate accept ${row.id}\` or answer it in the desktop app`,
    );
  });

  test("offline -> failed with reason, readwise paused", async () => {
    offline = true;
    // No scheduler_state row exists beforehand: the pause must still land (setPaused alone is an
    // UPDATE that silently does nothing without one).
    expect(loadSchedulerState(db, LEGACY)).toBeNull();
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain("ENOTFOUND");
    expect(row.stagePath).toBeNull();
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toContain("ENOTFOUND");
    expect(health.lastError).toContain("`nimbus connector migrate retry`");
  });

  test("offline with an existing scheduler row keeps its cursor and pauses it", async () => {
    pauseLegacyService(db, LEGACY, "seed", NOW);
    db.run("UPDATE scheduler_state SET cursor = ?, paused = 0 WHERE service_id = ?", [
      SEEDED_CURSOR,
      LEGACY,
    ]);
    offline = true;
    await engine().evaluate();
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(loadSchedulerState(db, LEGACY)?.cursor).toBe(SEEDED_CURSOR);
  });

  test("a failed row is retried by the next evaluate", async () => {
    offline = true;
    await engine().evaluate();
    const failed = onlyRow();
    offline = false;
    await engine().evaluate();
    const row = onlyRow();
    expect(row.id).toBe(failed.id);
    expect(row.state).toBe("awaiting_approval");
  });

  test("permission drift from the table -> failed naming the field", async () => {
    await buildRegistry({ ...MANIFEST_EXTRA, permissions: { network: [HOST, "evil.example"] } });
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain("permissions.network");
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
  });

  test("credential and item-type drift each name their field", async () => {
    await buildRegistry({ ...MANIFEST_EXTRA, credentials: { api_key: { env: "FIXTURE_KEY" } } });
    await engine().evaluate();
    expect(onlyRow().error).toContain("credentials");
    db.run("DELETE FROM connector_migration");
    await buildRegistry({
      ...MANIFEST_EXTRA,
      sync: { contract: "1", intervalSeconds: 600, itemTypes: ["highlight"] },
    });
    await engine().evaluate();
    expect(onlyRow().error).toContain("sync.itemTypes");
  });

  test("an extension id that is already installed -> failed, telling the owner to remove it and retry", async () => {
    const e = engine();
    await e.evaluate();
    await e.accept(onlyRow().id, consentThat(true, []));
    // A second legacy service bound to the same, now installed, extension id.
    const other = {
      ...entry,
      legacyServiceId: "fixture_other",
      credentials: { token: LEGACY_KEY },
    };
    await engine({ continuityTable: [entry, other] }).evaluate();
    const row = listMigrations(db).find((r) => r.legacyServiceId === "fixture_other");
    expect(row?.state).toBe("failed");
    expect(row?.error).toBe(
      `${EXT} already installed — remove it, then \`nimbus connector migrate retry\``,
    );
    expect(getConnectorHealth(db, "fixture_other").lastError).toBe(row?.error ?? "");
  });

  test("evaluate is idempotent", async () => {
    const e = engine();
    await Promise.all([e.evaluate(), e.evaluate()]);
    const first = onlyRow();
    const fetchesAfterFirst = fetches.length;
    await e.evaluate();
    await engine().evaluate();
    expect(onlyRow()).toEqual(first);
    // An intact stage is not fetched again, by this engine or a fresh one.
    expect(fetches).toHaveLength(fetchesAfterFirst);
    // Two concurrent calls fetched once: one index, one manifest, one package.
    expect(fetchesAfterFirst).toBe(3);
  });

  test("restart with missing stage re-prepares", async () => {
    await engine().evaluate();
    const first = onlyRow();
    rmSync(stageRootOf(first.id), { recursive: true, force: true });
    await engine().evaluate();
    const row = onlyRow();
    expect(row.id).toBe(first.id);
    expect(row.state).toBe("awaiting_approval");
    expect(row.treeDigest).toBe(first.treeDigest);
    expect(existsSync(row.stagePath ?? "")).toBe(true);
  });

  test("restart with a tampered stage -> failed with a digest reason, stage deleted", async () => {
    await engine().evaluate();
    const first = onlyRow();
    writeFileSync(join(first.stagePath ?? "", "dist", "index.js"), "export const pwned = 1;\n");
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain("digest");
    expect(existsSync(stageRootOf(row.id))).toBe(false);
  });

  test("approved and declined rows are never prepared again", async () => {
    const e = engine();
    await e.evaluate();
    e.decline(onlyRow().id);
    const n = fetches.length;
    await e.evaluate();
    expect(onlyRow().state).toBe("declined");
    expect(fetches).toHaveLength(n);
  });
});

describe("accept", () => {
  test("accept is one prompt", async () => {
    const e = engine();
    await e.evaluate();
    const seen: MigrationConsentPayload[] = [];
    const out = await e.accept(onlyRow().id, consentThat(true, seen));
    expect(out.state).toBe("approved");
    expect(seen).toHaveLength(1);
    // The install was gated (its audit row is `approved`, not `not_required`) by that same decision;
    // nothing else asked the owner anything.
    const audit = db
      .query("SELECT action_type, hitl_status FROM audit_log WHERE hitl_status != 'not_required'")
      .all() as Array<{ action_type: string; hitl_status: string }>;
    expect(audit).toEqual([{ action_type: "extension.install_complete", hitl_status: "approved" }]);
  });

  test("accept installs, grants with readwise.token, no re-entry", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    await e.accept(row.id, consentThat(true, []));
    const installed = listExtensions(db).find((r) => r.id === EXT);
    expect(installed?.tree_digest).toBe(row.treeDigest ?? "");
    const grant = getRunGrant(db, EXT);
    expect(grant?.credentials_json).toBe(
      `{"token":{"env":"FIXTURE_TOKEN","vaultKey":"${LEGACY_KEY}"}}`,
    );
    expect(grant?.model_access).toBe(0);
    expect(await vault.get(LEGACY_KEY)).toBe(TOKEN);
    expect(refreshed).toEqual([EXT]);
    expect(resumed).toEqual([LEGACY]);
    const done = getMigration(db, row.id);
    expect(done?.state).toBe("approved");
    expect(done?.stagePath).toBeNull();
    expect(existsSync(stageRootOf(row.id))).toBe(false);
  });

  test("accept clears scheduler_state.paused", async () => {
    const e = engine();
    await e.evaluate();
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    await e.accept(onlyRow().id, consentThat(true, []));
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(0);
    expect(getConnectorHealth(db, LEGACY).state).not.toBe("paused");
  });

  test("tampered stage fails accept", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    writeFileSync(join(row.stagePath ?? "", "dist", "index.js"), "export const pwned = 1;\n");
    const seen: MigrationConsentPayload[] = [];
    await expect(e.accept(row.id, consentThat(true, seen))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED.*digest/,
    );
    expect(seen).toEqual([]);
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
  });

  test("a stage tampered while the prompt is open fails after consent and installs nothing", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    const out = e.accept(row.id, async () => {
      writeFileSync(join(row.stagePath ?? "", "extra.js"), "1;\n");
      return true;
    });
    await expect(out).rejects.toThrow(/ERR_EXTENSION_MIGRATION_FAILED/);
    expect(listExtensions(db)).toEqual([]);
    expect(getMigration(db, row.id)?.state).toBe("failed");
  });

  test("an install whose tree digest differs from the staged one is undone and the row fails", async () => {
    // The stage changes between the post-prompt re-digest and the copy: only the post-install
    // equality can see it.
    const e = engine({
      installVerified: async (d, pkg, channel) => {
        writeFileSync(join(pkg.sourceRoot, "late.js"), "1;\n");
        return installVerifiedRegistryPackage(d, pkg, channel);
      },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED.*digest/,
    );
    expect(existsSync(join(tmp, "data", "extensions", EXT))).toBe(false);
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(getMigration(db, row.id)?.state).toBe("failed");
  });

  test("a consent that is not given leaves the row awaiting approval, the stage in place, nothing installed", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(false, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_NOT_APPROVED/,
    );
    expect(getMigration(db, row.id)?.state).toBe("awaiting_approval");
    expect(existsSync(row.stagePath ?? "")).toBe(true);
    expect(listExtensions(db)).toEqual([]);
  });

  test("accept and decline refuse a row that is not awaiting approval, and an unknown id", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    await e.accept(row.id, consentThat(true, []));
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_NOT_PENDING/,
    );
    expect(() => e.decline(row.id)).toThrow(/ERR_EXTENSION_MIGRATION_NOT_PENDING/);
    await expect(e.accept("nope", consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_NOT_FOUND/,
    );
    expect(() => e.decline("nope")).toThrow(/ERR_EXTENSION_MIGRATION_NOT_FOUND/);
  });

  test("a second accept while the first is prompting is refused as busy", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    let release: (v: boolean) => void = () => {};
    const first = e.accept(row.id, () => new Promise<boolean>((r) => (release = r)));
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_BUSY/,
    );
    expect(() => e.decline(row.id)).toThrow(/ERR_EXTENSION_MIGRATION_BUSY/);
    release(true);
    expect((await first).state).toBe("approved");
  });

  test("the runtime switch off refuses before the prompt and changes nothing", async () => {
    await engine().evaluate();
    const row = onlyRow();
    const seen: MigrationConsentPayload[] = [];
    await expect(
      engine({ runtimeEnabled: false }).accept(row.id, consentThat(true, seen)),
    ).rejects.toThrow(/ERR_EXTENSION_MIGRATION_RUNTIME_DISABLED/);
    expect(seen).toEqual([]);
    expect(getMigration(db, row.id)?.state).toBe("awaiting_approval");
  });

  test("a legacy id that is (again) bundled refuses accept without prompting", async () => {
    await engine().evaluate();
    const row = onlyRow();
    const seen: MigrationConsentPayload[] = [];
    await expect(
      engine({ isBundledConnector: () => true }).accept(row.id, consentThat(true, seen)),
    ).rejects.toThrow(/ERR_EXTENSION_MIGRATION_BUNDLED/);
    expect(seen).toEqual([]);
  });

  test("restart with missing stage: accept before re-evaluation fails rather than installing", async () => {
    await engine().evaluate();
    const row = onlyRow();
    rmSync(stageRootOf(row.id), { recursive: true, force: true });
    await expect(engine().accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED/,
    );
    expect(listExtensions(db)).toEqual([]);
  });
});

describe("the consent payload", () => {
  async function payloadOn(
    platform: NodeJS.Platform,
    canConfine: string | null = null,
  ): Promise<MigrationConsentPayload> {
    const e = engine({ env: grantEnv(platform), sandbox: { canConfine: () => canConfine } });
    await e.evaluate();
    const seen: MigrationConsentPayload[] = [];
    await e.accept(onlyRow().id, consentThat(false, seen)).catch(() => {});
    const p = seen[0];
    if (p === undefined) throw new Error("premise: the owner was asked");
    return p;
  }

  test("verbatim on Linux, with a sandbox that can confine", async () => {
    const p = await payloadOn("linux");
    const row = onlyRow();
    expect(p).toEqual({
      migrationId: row.id,
      extensionId: EXT,
      summary:
        "Fixture Reader moved out of the built-in set and is now an extension from the official Nimbus registry. Keep it? It needs the same access as before: network access to reader.example, your existing Fixture Reader token.",
      publisher: { id: "nimbus", fingerprint: publisherKeyFingerprint(entry.publisherKey) },
      version: "1.0.0",
      network: "network access to reader.example",
      readTools:
        "Fixture Reader's live read tools now need your approval per call and are not offered to the model unless you run `nimbus extension approve com.example.reader --model`; questions are still answered from your index.",
      knownLoss:
        "A few rare items may not carry over: items dated before 1970, or whose metadata is larger than 64 KiB.",
    });
  });

  test("on Windows the network line does not claim a host restriction, and a sandbox refusal is named", async () => {
    const p = await payloadOn("win32", "the AppContainer helper is missing");
    expect(p.network).toBe("network access (Windows cannot limit this to reader.example)");
    expect(p.summary).toContain("network access (Windows cannot limit this to reader.example)");
    expect(p.sandbox).toBe(
      "sync will stay paused until the sandbox is fixed: the AppContainer helper is missing",
    );
  });

  test("survives both redactors: no field name hides what the owner is asked", async () => {
    const { redactPayloadForConsentDisplay } = await import("../../engine/executor.ts");
    const { redactAuditPayload } = await import("../../audit/format-audit-payload.ts");
    const p = await payloadOn("linux");
    expect(JSON.stringify(redactPayloadForConsentDisplay(p))).not.toContain("[REDACTED]");
    expect(redactAuditPayload(p, 8192)).toContain(publisherKeyFingerprint(entry.publisherKey));
  });

  test("the Readwise wording of the paused reason is the brief's, verbatim", () => {
    expect(awaitingApprovalReason("Readwise", "abc")).toBe(
      "Readwise moved to an extension — run `nimbus connector migrate accept abc` or answer it in the desktop app",
    );
  });
});

describe("decline", () => {
  test("a refused transition surfaces as an error, keeps the stage, and does not pause or report success", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    setPaused(db, LEGACY, false);
    // Another writer wins the race: the store's guarded UPDATE changes nothing.
    db.run(
      "CREATE TRIGGER refuse_decline BEFORE UPDATE ON connector_migration WHEN NEW.state = 'declined' BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(() => e.decline(row.id)).toThrow(/ERR_EXTENSION_MIGRATION_NOT_PENDING/);
    expect(getMigration(db, row.id)?.state).toBe("awaiting_approval");
    expect(existsSync(stageRootOf(row.id))).toBe(true);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(0);
  });

  test("decline keeps items and deletes stage", async () => {
    upsertIndexedItem(db, {
      service: LEGACY,
      type: "highlight",
      externalId: "101",
      title: "kept",
      modifiedAt: 1,
      syncedAt: 1,
    });
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    const out = e.decline(row.id);
    expect(out.state).toBe("declined");
    expect(out.stagePath).toBeNull();
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(listExtensions(db)).toEqual([]);
    const items = db.query("SELECT id FROM item WHERE service = ?").all(LEGACY) as Array<{
      id: string;
    }>;
    expect(items.map((i) => i.id)).toEqual([`${LEGACY}:101`]);
    // Still off — and the paused reason no longer offers an accept that would now refuse.
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(getConnectorHealth(db, LEGACY).lastError).not.toContain("migrate accept");
  });
});

describe("credentials never leak", () => {
  test("the token value is in no consent payload, row, error, log, health or audit text", async () => {
    const seen: MigrationConsentPayload[] = [];
    const errors: string[] = [];
    // A failure, a drift, a decline-free accept: every path that writes text.
    offline = true;
    await engine().evaluate();
    offline = false;
    await engine().evaluate();
    const e = engine({ env: grantEnv("win32"), sandbox: { canConfine: () => "no helper" } });
    await e.accept(onlyRow().id, consentThat(false, seen)).catch((err: unknown) => {
      errors.push(String(err));
    });
    await e.accept(onlyRow().id, consentThat(true, seen));
    await e.accept(onlyRow().id, consentThat(true, seen)).catch((err: unknown) => {
      errors.push(String(err));
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(errors).toHaveLength(2);
    const dump = [
      JSON.stringify(seen),
      JSON.stringify(listMigrations(db)),
      errors.join("\n"),
      JSON.stringify(logs),
      ...[
        "connector_migration",
        "sync_state",
        "connector_health_history",
        "scheduler_state",
        "audit_log",
        "extension_run_grant",
        "extension",
      ].map((t) => JSON.stringify(db.query(`SELECT * FROM ${t}`).all())),
    ].join("\n");
    expect(dump).not.toContain(TOKEN);
    // The legacy Vault KEY is not shown in the prompt either — only "your existing … token".
    expect(JSON.stringify(seen)).not.toContain(LEGACY_KEY);
  });
});

describe("in place", () => {
  test("approved migration upgrades readwise items in place", async () => {
    // Bundled-style rows and scheduler row for the (fixture) legacy service, as the bundled
    // connector left them: bare numeric highlight ids, `book/<id>` book ids, the resting cursor.
    for (const [type, externalId] of [
      ["highlight", "101"],
      ["highlight", "102"],
      ["book", "book/7"],
    ] as const) {
      upsertIndexedItem(db, {
        service: LEGACY,
        type,
        externalId,
        title: `old ${externalId}`,
        modifiedAt: 1,
        syncedAt: 1,
      });
    }
    pauseLegacyService(db, LEGACY, "seed", NOW);
    db.run("UPDATE scheduler_state SET cursor = ?, paused = 0 WHERE service_id = ?", [
      SEEDED_CURSOR,
      LEGACY,
    ]);
    const idsBefore = (
      db.query("SELECT id FROM item WHERE service = ? ORDER BY id").all(LEGACY) as Array<{
        id: string;
      }>
    ).map((r) => r.id);

    const egress: Array<{ destination: string; method: string }> = [];
    const sched = new SyncScheduler(
      {
        ...unboundSyncCapabilities(),
        db,
        vault,
        logger: pino({ level: "silent" }),
        rateLimiter: new ProviderRateLimiter(),
        sandboxCwd: os.tmpdir(),
        credentialFor: () => ({ credential: "personal" }),
        runTeamList: async () => [],
        depth: "full",
        extensionCredentialsFor: createExtensionCredentialsResolver(db, [entry]),
      },
      undefined,
      { appendSyncEgress: (r) => egress.push(r) },
    );
    extraCleanups.push(() => sched.stop());
    const cursorsSeen: Array<string | null> = [];
    const registrar = createExtensionSyncRegistrar({
      db,
      vault,
      scheduler: sched,
      mesh: {
        callExtensionSyncTool: async (_id, req) => {
          cursorsSeen.push(req.cursor);
          return {
            status: "ok",
            items: [
              {
                type: "highlight",
                externalId: "101",
                title: "new 101",
                modifiedAt: 9,
                metadata: {},
              },
              {
                type: "highlight",
                externalId: "102",
                title: "new 102",
                modifiedAt: 9,
                metadata: {},
              },
              {
                type: "book",
                externalId: "book/7",
                title: "new book",
                modifiedAt: 9,
                metadata: {},
              },
            ],
            cursor: null,
            hasMore: false,
          };
        },
      },
      sandbox: { canConfine: () => null },
      runtimeReadPaths: () => [join(tmp, "bun-bin")],
      table: [entry],
    });

    const e = engine({ extensionSync: registrar, scheduler: sched });
    await e.evaluate();
    await e.accept(onlyRow().id, consentThat(true, []));
    expect(sched.syncableFor(LEGACY)).toBeDefined();
    await sched.forceSync(LEGACY);

    const after = db
      .query("SELECT id, title FROM item WHERE service = ? ORDER BY id")
      .all(LEGACY) as Array<{ id: string; title: string }>;
    expect(after.map((r) => r.id)).toEqual(idsBefore);
    expect(after.map((r) => r.title)).toEqual(["new 101", "new 102", "new book"].sort());
    expect((db.query("SELECT COUNT(*) AS n FROM item").get() as { n: number }).n).toBe(
      idsBefore.length,
    );
    expect(cursorsSeen).toEqual([SEEDED_CURSOR]);
    expect(loadSchedulerState(db, LEGACY)?.cursor).toBe(SEEDED_CURSOR);
    expect(egress).toHaveLength(1);
    expect(readdirSync(join(tmp, "data", "migrations"))).toEqual([]);
  });
});

test("a row left by an older release whose stage path lies outside its own directory is never trusted", async () => {
  await engine().evaluate();
  const row = onlyRow();
  db.run("DELETE FROM connector_migration");
  recordMigrationPrepared(
    db,
    {
      id: row.id,
      legacyServiceId: LEGACY,
      extensionId: EXT,
      version: "1.0.0",
      treeDigest: row.treeDigest ?? "",
      stagePath: tmp,
    },
    NOW,
  );
  await expect(engine().accept(row.id, consentThat(true, []))).rejects.toThrow(
    /ERR_EXTENSION_MIGRATION_FAILED/,
  );
  expect(existsSync(tmp)).toBe(true);
  expect(listExtensions(db)).toEqual([]);
});

describe("fix round 1: retry (B10)", () => {
  test("after decline, boot evaluate does not re-prepare", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    e.decline(row.id);
    const n = fetches.length;
    await e.evaluate();
    await engine().evaluate();
    expect(onlyRow().state).toBe("declined");
    expect(fetches).toHaveLength(n);
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    // The declined note names the way back.
    expect(getConnectorHealth(db, LEGACY).lastError).toContain(
      "`nimbus connector migrate retry` to change your mind",
    );
  });

  test("retry re-prepares a declined row", async () => {
    const e = engine();
    await e.evaluate();
    const declined = e.decline(onlyRow().id);
    await e.retry();
    const row = onlyRow();
    expect(row.id).toBe(declined.id);
    expect(row.state).toBe("awaiting_approval");
    expect(existsSync(row.stagePath ?? "")).toBe(true);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(
      awaitingApprovalReason("Fixture Reader", row.id),
    );
    // …and it can then be accepted.
    expect((await e.accept(row.id, consentThat(true, []))).state).toBe("approved");
  });

  test("retry re-prepares a failed row", async () => {
    offline = true;
    await engine().evaluate();
    expect(onlyRow().state).toBe("failed");
    offline = false;
    await engine().retry();
    expect(onlyRow().state).toBe("awaiting_approval");
  });

  test("retry on an approved row is a no-op", async () => {
    const e = engine();
    await e.evaluate();
    await e.accept(onlyRow().id, consentThat(true, []));
    const before = onlyRow();
    const n = fetches.length;
    await e.retry();
    expect(onlyRow()).toEqual(before);
    expect(fetches).toHaveLength(n);
  });

  test("retry with no Vault credential prepares nothing, even for a declined row", async () => {
    const e = engine();
    await e.evaluate();
    e.decline(onlyRow().id);
    await vault.delete(LEGACY_KEY);
    await e.retry();
    expect(onlyRow().state).toBe("declined");
  });
});

describe("fix round 1: a decline during evaluate's Vault read", () => {
  test("is not overwritten: no re-prepare, no orphan stage, no awaiting-approval pause", async () => {
    await engine().evaluate();
    const row = onlyRow();
    // A missing stage makes the next evaluate re-prepare — unless the decline below wins.
    rmSync(stageRootOf(row.id), { recursive: true, force: true });
    let e: MigrationEngine | undefined;
    let declinedOnce = false;
    const racing: NimbusVault = {
      ...vault,
      get: async (key) => {
        if (!declinedOnce && e !== undefined) {
          declinedOnce = true;
          e.decline(row.id);
        }
        return vault.get(key);
      },
    };
    e = engine({ vault: racing });
    const n = fetches.length;
    await e.evaluate();
    expect(declinedOnce).toBe(true);
    expect(onlyRow().state).toBe("declined");
    expect(fetches).toHaveLength(n);
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(getConnectorHealth(db, LEGACY).lastError).toContain("was declined");
  });
});

describe("fix round 1: accept checks the sync took over the LEGACY id", () => {
  async function acceptExpectingFailure(pattern: RegExp): Promise<string> {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(pattern);
    // Nothing half-approved: row failed, extension and grant gone, never resumed, still paused,
    // stage deleted, nothing left registered.
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(existsSync(join(tmp, "data", "extensions", EXT))).toBe(false);
    expect(resumed).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect([...registered.keys()]).toEqual([]);
    return getMigration(db, row.id)?.error ?? "";
  }

  test("refresh registers nothing -> failed, not resumed", async () => {
    registerMode = "none";
    const error = await acceptExpectingFailure(/ERR_EXTENSION_MIGRATION_FAILED.*not registered/);
    expect(error).toContain(`not registered under ${LEGACY}`);
  });

  test("refresh registers under ext_<slug> -> failed", async () => {
    registerMode = "ext";
    const error = await acceptExpectingFailure(/ERR_EXTENSION_MIGRATION_FAILED.*own id/);
    expect(error).toContain(CODE_ID);
  });

  test("another syncable already holding the legacy id -> failed", async () => {
    registered.set(LEGACY, "someone-else");
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(/already uses/);
    expect(listExtensions(db)).toEqual([]);
    expect(resumed).toEqual([]);
  });

  test("a throw after the grant (resume) leaves no half-approved state", async () => {
    const e = engine({
      scheduler: {
        resume: () => {
          throw new Error("scheduler stopped");
        },
        syncableFor: (id) => registered.get(id),
      },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(/scheduler stopped/);
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect([...registered.keys()]).toEqual([]);
  });
});

describe("Task 5.4 M1: an undone install whose files cannot be removed still fails the row", () => {
  const ebusy = (): never => {
    const err = new Error("EBUSY: resource busy or locked, rmdir 'x'") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    throw err;
  };

  test("a throw after the grant with a throwing removal: unregistered, failed, still paused", async () => {
    const e = engine({
      removeInstallTree: ebusy,
      scheduler: {
        resume: () => {
          throw new Error("scheduler stopped");
        },
        syncableFor: (id) => registered.get(id),
      },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(/scheduler stopped/);
    // The unregister ran: the registrar was refreshed again after the undo and holds nothing.
    expect([...registered.keys()]).toEqual([]);
    expect(refreshed.filter((id) => id === EXT)).toHaveLength(2);
    // failAccept ran: the row failed and the legacy service stays paused with the reason.
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(getConnectorHealth(db, LEGACY).lastError).toContain("scheduler stopped");
    // The rows went first, so the leftover files can never run.
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(JSON.stringify(logs)).toContain("could not be removed from disk");
  });

  test("a tree-digest mismatch with a throwing removal still fails the row", async () => {
    const e = engine({
      removeInstallTree: ebusy,
      installVerified: async (d, pkg, channel) => {
        writeFileSync(join(pkg.sourceRoot, "late.js"), "1;\n");
        return installVerifiedRegistryPackage(d, pkg, channel);
      },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED.*digest/,
    );
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
  });
});

describe("Task 5.4: a sandbox that cannot confine keeps sync paused after accept (spec § 7.2 step 4a)", () => {
  test("the prompt says so, and the scheduler's preflight re-pauses with the fix named", async () => {
    const REASON = "the sandbox helper is not installed";
    const egress: Array<{ destination: string; method: string }> = [];
    const sched = new SyncScheduler(
      {
        ...unboundSyncCapabilities(),
        db,
        vault,
        logger: pino({ level: "silent" }),
        rateLimiter: new ProviderRateLimiter(),
        sandboxCwd: os.tmpdir(),
        credentialFor: () => ({ credential: "personal" }),
        runTeamList: async () => [],
        depth: "full",
        extensionCredentialsFor: createExtensionCredentialsResolver(db, [entry]),
      },
      undefined,
      { appendSyncEgress: (r) => egress.push(r) },
    );
    extraCleanups.push(() => sched.stop());
    const meshCalls: string[] = [];
    // The forced-canConfine seam PR 3's registrar tests use: the registrar's own `sandbox`.
    const registrar = createExtensionSyncRegistrar({
      db,
      vault,
      scheduler: sched,
      mesh: {
        callExtensionSyncTool: async (id) => {
          meshCalls.push(id);
          return { status: "ok", items: [], cursor: null, hasMore: false };
        },
      },
      sandbox: { canConfine: () => REASON },
      runtimeReadPaths: () => [join(tmp, "bun-bin")],
      table: [entry],
    });
    const seen: MigrationConsentPayload[] = [];
    const e = engine({
      extensionSync: registrar,
      scheduler: sched,
      sandbox: { canConfine: () => REASON },
    });
    await e.evaluate();
    const row = await e.accept(onlyRow().id, consentThat(true, seen));
    expect(row.state).toBe("approved");
    expect(seen[0]?.sandbox).toBe(`sync will stay paused until the sandbox is fixed: ${REASON}`);

    // Accept resumed the service; the first run's preflight pauses it again, before any spawn.
    await sched.forceSync(LEGACY).catch(() => undefined);
    expect(meshCalls).toEqual([]);
    expect(egress).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toContain(`sandbox cannot confine this extension: ${REASON}`);
    expect(health.lastError).toContain(`nimbus connector resume ${LEGACY}`);
  });
});

describe("Task 5.4 fix round 1: no stored or thrown text names a path; a leftover install is handled", () => {
  test("a failure whose error names a path with a space stores a path-free row error and paused reason", async () => {
    // A data root with a space in it, as macOS's `~/Library/Application Support/Nimbus` has, and an
    // UNQUOTED path under it: only the known-root pass can tell where that path ends.
    const dataDir = join(tmp, "Application Support", "Nimbus", "data");
    const leaky = join(dataDir, "migrations", "x", "index.json");
    const e = engine({
      dataDir,
      extensionsDir: join(dataDir, "extensions"),
      fetch: {
        ...deps().fetch,
        fetchFn: async () => {
          throw new Error(`ENOENT: no such file or directory, open ${leaky}`);
        },
      },
    });
    await e.evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    const reason = getConnectorHealth(db, LEGACY).lastError ?? "";
    for (const text of [row.error ?? "", reason]) {
      expect(text).toContain("<path>");
      expect(text).not.toContain(tmp);
      expect(text).not.toContain("Support");
    }
  });

  test("a leftover install directory with no extension row is removed before the prompt, and accept succeeds", async () => {
    const e = engine();
    await e.evaluate();
    const leftover = join(tmp, "data", "extensions", EXT);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, "stale.js"), "1;\n");
    const seen: MigrationConsentPayload[] = [];
    const row = await e.accept(onlyRow().id, consentThat(true, seen));
    expect(row.state).toBe("approved");
    expect(seen).toHaveLength(1);
    expect(existsSync(join(leftover, "stale.js"))).toBe(false);
  });

  test("a leftover that cannot be removed fails the row with an actionable, path-free message and no prompt", async () => {
    const e = engine({
      removeInstallTree: () => {
        throw new Error("EPERM: operation not permitted");
      },
    });
    await e.evaluate();
    const id = onlyRow().id;
    const leftover = join(tmp, "data", "extensions", EXT);
    mkdirSync(leftover, { recursive: true });
    const seen: MigrationConsentPayload[] = [];
    const err = await e.accept(id, consentThat(true, seen)).then(
      () => undefined,
      (x: unknown) => x as Error,
    );
    expect(err?.message).toMatch(/^ERR_EXTENSION_MIGRATION_FAILED: /);
    expect(err?.message).toContain(`"${EXT}" folder`);
    expect(err?.message).toContain("nimbus connector migrate retry");
    expect(err?.message).not.toContain(tmp);
    expect(seen).toEqual([]);
    expect(getMigration(db, id)?.state).toBe("failed");
    expect(getConnectorHealth(db, LEGACY).lastError).toContain(EXT);
  });
});

/** Runs `fn` and returns what it threw, or undefined. */
async function thrownBy(fn: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  return undefined;
}

/** Throws a value that is not an `Error`, as a misbehaving dependency might. */
function throwNonError(): never {
  const thrown: unknown = "not-an-error-object";
  throw thrown;
}

describe("branch coverage: the pause and the consent payload", () => {
  test("a known connector id takes its catalogue interval, and the clock defaults to now", () => {
    pauseLegacyService(db, "github", "paused for a test");
    expect(loadSchedulerState(db, "github")?.paused).toBe(1);
    expect(getConnectorHealth(db, "github").lastError).toBe("paused for a test");
  });

  test("an entry with no display name and no network is described by its legacy id", async () => {
    await buildRegistry({ ...MANIFEST_EXTRA, permissions: {} });
    const { displayName: _name, ...nameless } = entry;
    const table = [{ ...nameless, expectedPermissions: { network: [], read: [], write: [] } }];
    const e = engine({ continuityTable: table });
    await e.evaluate();
    const row = onlyRow();
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(awaitingApprovalReason(LEGACY, row.id));
    const seen: MigrationConsentPayload[] = [];
    expect((await e.accept(row.id, consentThat(true, seen))).state).toBe("approved");
    expect(seen[0]?.network).toBe("no network access");
    expect(seen[0]?.summary).toContain(`${LEGACY} moved out of the built-in set`);
  });

  test("a decline for a row this release no longer migrates names the legacy id", async () => {
    await engine().evaluate();
    const row = onlyRow();
    const declined = engine({ continuityTable: [] }).decline(row.id);
    expect(declined.state).toBe("declined");
    expect(getConnectorHealth(db, LEGACY).lastError).toContain(`${LEGACY} stays off`);
  });
});

describe("branch coverage: verification against the continuity table", () => {
  test("host and item-type lists are compared as sets, whatever their order", async () => {
    await buildRegistry({
      ...MANIFEST_EXTRA,
      permissions: { network: ["b.example", "a.example", HOST] },
      sync: { ...MANIFEST_EXTRA.sync, itemTypes: ["highlight", "book", "article"] },
    });
    const table = [
      {
        ...entry,
        expectedPermissions: { network: [HOST, "B.example", "a.example"], read: [], write: [] },
        itemTypes: ["article", "highlight", "book"],
      },
    ];
    await engine({ continuityTable: table }).evaluate();
    expect(onlyRow().state).toBe("awaiting_approval");
  });

  test("a different source root fingerprint is named", async () => {
    const table = [{ ...entry, sourceRootFingerprint: "0".repeat(16) }];
    await engine({ continuityTable: table }).evaluate();
    expect(onlyRow().error).toContain("sourceRootFingerprint differs");
  });

  test("a different publisher key is named", async () => {
    const table = [{ ...entry, publisherKey: Buffer.alloc(32, 7).toString("base64") }];
    await engine({ continuityTable: table }).evaluate();
    expect(onlyRow().error).toContain("publisherKey differs");
  });

  test("an extra filesystem read grant is named", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    await buildRegistry({
      ...MANIFEST_EXTRA,
      permissions: { network: [HOST], filesystem: { read: [outside], write: [] } },
    });
    await engine().evaluate();
    expect(onlyRow().error).toContain("permissions.read differs");
  });

  test("an extra filesystem write grant is named", async () => {
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    await buildRegistry({
      ...MANIFEST_EXTRA,
      permissions: { network: [HOST], filesystem: { read: [], write: [outside] } },
    });
    await engine().evaluate();
    expect(onlyRow().error).toContain("permissions.write differs");
  });

  test("a grant that cannot be resolved is a permissions difference", async () => {
    await buildRegistry({
      ...MANIFEST_EXTRA,
      permissions: { network: [HOST], filesystem: { read: [join(tmp, "missing")], write: [] } },
    });
    await engine().evaluate();
    expect(onlyRow().error).toContain("permissions differs");
  });

  test("a manifest that declares no credentials differs from an entry that maps one", async () => {
    const { credentials: _c, ...noCredentials } = MANIFEST_EXTRA;
    await buildRegistry(noCredentials);
    await engine().evaluate();
    expect(onlyRow().error).toContain("credentials differs");
  });

  test("an entry that maps no credential is never migrated, and nothing is fetched", async () => {
    await engine({ continuityTable: [{ ...entry, credentials: {} }] }).evaluate();
    expect(listMigrations(db)).toEqual([]);
    expect(fetches).toEqual([]);
  });
});

describe("branch coverage: prepare and the staged tree", () => {
  test("an id that is not a safe path segment fails the row rather than escaping the data dir", async () => {
    await engine({ newId: () => "../escape" }).evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain("not a safe path segment");
    expect(JSON.stringify(logs)).toContain("could not be removed");
    expect(fetches).toEqual([]);
  });

  test("a stored row with an unsafe id has no usable stage and is failed on re-preparing", async () => {
    recordMigrationPrepared(
      db,
      {
        id: "bad id",
        legacyServiceId: LEGACY,
        extensionId: EXT,
        version: "1.0.0",
        treeDigest: "d".repeat(64),
        stagePath: join(tmp, "elsewhere"),
      },
      NOW,
    );
    await engine().evaluate();
    expect(onlyRow().state).toBe("failed");
  });

  test("a row whose stage path was cleared is prepared again under the same id", async () => {
    await engine().evaluate();
    const first = onlyRow();
    db.run("UPDATE connector_migration SET stage_path = NULL WHERE id = ?", [first.id]);
    await engine().evaluate();
    const row = onlyRow();
    expect(row.id).toBe(first.id);
    expect(row.state).toBe("awaiting_approval");
    expect(existsSync(row.stagePath ?? "")).toBe(true);
  });

  test("a stage path outside the migration's own directory is a tampered stage", async () => {
    await engine().evaluate();
    const first = onlyRow();
    db.run("UPDATE connector_migration SET stage_path = ? WHERE id = ?", [tmp, first.id]);
    await engine().evaluate();
    expect(onlyRow().state).toBe("failed");
    expect(onlyRow().error).toContain("digest");
  });

  test("a fetch that rejects with a plain value is recorded as text", async () => {
    const base = deps().fetch;
    await engine({ fetch: { ...base, fetchFn: async () => throwNonError() } }).evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).not.toBeNull();
  });

  test("a row declined while its fetch was failing is neither rewritten nor paused over", async () => {
    await engine().evaluate();
    const row = onlyRow();
    rmSync(stageRootOf(row.id), { recursive: true, force: true });
    const reason = getConnectorHealth(db, LEGACY).lastError;
    const base = deps().fetch;
    let declinedOnce = false;
    await engine({
      fetch: {
        ...base,
        fetchFn: async () => {
          if (!declinedOnce) {
            declinedOnce = true;
            finishMigration(db, row.id, "declined", null, NOW);
          }
          throw new Error("getaddrinfo ENOTFOUND registry.nimbus.test");
        },
      },
    }).evaluate();
    expect(declinedOnce).toBe(true);
    expect(getMigration(db, row.id)?.state).toBe("declined");
    expect(getMigration(db, row.id)?.error).toBeNull();
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(reason);
  });

  test("a row declined while its package was fetched leaves no stage and no new pause", async () => {
    await engine().evaluate();
    const row = onlyRow();
    rmSync(stageRootOf(row.id), { recursive: true, force: true });
    const reason = getConnectorHealth(db, LEGACY).lastError;
    const base = deps().fetch;
    let declinedOnce = false;
    await engine({
      fetch: {
        ...base,
        fetchFn: async (url, init) => {
          if (!declinedOnce) {
            declinedOnce = true;
            finishMigration(db, row.id, "declined", null, NOW);
          }
          return base.fetchFn(url, init);
        },
      },
    }).evaluate();
    expect(declinedOnce).toBe(true);
    expect(getMigration(db, row.id)?.state).toBe("declined");
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(reason);
  });
});

describe("branch coverage: concurrency and failures inside evaluate", () => {
  test("evaluate leaves a legacy service alone while its accept is in flight", async () => {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    let release: (v: boolean) => void = () => {};
    const accepting = e.accept(row.id, () => new Promise<boolean>((r) => (release = r)));
    const n = fetches.length;
    await e.evaluate();
    expect(fetches).toHaveLength(n);
    release(true);
    expect((await accepting).state).toBe("approved");
  });

  test("an accept that starts during evaluate's Vault read wins: evaluate then prepares nothing", async () => {
    await engine().evaluate();
    const row = onlyRow();
    let open: () => void = () => {};
    let held = false;
    const slow: NimbusVault = {
      ...vault,
      get: async (key) => {
        if (held) await new Promise<void>((r) => (open = r));
        return vault.get(key);
      },
    };
    const e = engine({ vault: slow });
    held = true;
    const evaluating = e.evaluate();
    let release: (v: boolean) => void = () => {};
    const accepting = e.accept(row.id, () => new Promise<boolean>((r) => (release = r)));
    const n = fetches.length;
    open();
    await evaluating;
    expect(fetches).toHaveLength(n);
    held = false;
    release(true);
    expect((await accepting).state).toBe("approved");
  });

  test("a failure while evaluating one entry is logged and does not reject", async () => {
    for (const thrower of [
      () => {
        throw new Error("vault locked");
      },
      throwNonError,
    ]) {
      logs.length = 0;
      const broken: NimbusVault = { ...vault, get: async () => thrower() };
      await engine({ vault: broken }).evaluate();
      expect(JSON.stringify(logs)).toContain("connector migration evaluation failed");
    }
    expect(listMigrations(db)).toEqual([]);
  });

  test("retry waits for an evaluation in flight, and concurrent retries share one run", async () => {
    const e = engine();
    const evaluating = e.evaluate();
    const retries = [e.retry(), e.retry()];
    await Promise.all([evaluating, ...retries]);
    expect(onlyRow().state).toBe("awaiting_approval");
    expect(fetches).toHaveLength(3);
  });
});

describe("branch coverage: refusals and failures inside accept", () => {
  test("a row this release no longer migrates fails on accept", async () => {
    await engine().evaluate();
    const row = onlyRow();
    await expect(
      engine({ continuityTable: [] }).accept(row.id, consentThat(true, [])),
    ).rejects.toThrow(/ERR_EXTENSION_MIGRATION_FAILED: this release no longer migrates/);
    expect(getMigration(db, row.id)?.state).toBe("failed");
  });

  test("a gateway with no built-in registry refuses accept and changes nothing", async () => {
    await engine().evaluate();
    const row = onlyRow();
    await expect(engine({ builtin: null }).accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_NO_REGISTRY/,
    );
    expect(getMigration(db, row.id)?.state).toBe("awaiting_approval");
  });

  /**
   * Rewrites the staged tree and re-stamps the row's digest, so the stage is still "intact": this
   * is what a package that verified at prepare time but is unusable at accept time looks like.
   */
  async function prepareThenReshape(
    reshape: (root: string, manifestPath: string | undefined) => void,
  ): Promise<string> {
    const e = engine();
    await e.evaluate();
    const row = onlyRow();
    const root = row.stagePath ?? "";
    reshape(root, resolveExtensionManifestPath(root));
    db.run("UPDATE connector_migration SET tree_digest = ? WHERE id = ?", [
      computeExtensionTreeDigest(root),
      row.id,
    ]);
    const err = await thrownBy(() => e.accept(row.id, consentThat(true, [])));
    expect(err?.message).toMatch(/^ERR_EXTENSION_MIGRATION_FAILED: /);
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
    expect(existsSync(stageRootOf(row.id))).toBe(false);
    return err?.message ?? "";
  }

  function editManifest(
    manifestPath: string | undefined,
    edit: (m: Record<string, unknown>) => void,
  ): void {
    if (manifestPath === undefined) throw new Error("premise: a staged manifest");
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    edit(m);
    writeFileSync(manifestPath, JSON.stringify(m));
  }

  test("a staged package with no manifest fails", async () => {
    const error = await prepareThenReshape((_root, manifestPath) => {
      if (manifestPath !== undefined) rmSync(manifestPath);
    });
    expect(error).toContain("the staged package has no manifest");
  });

  test("a staged manifest that does not parse fails, naming why but not where", async () => {
    const error = await prepareThenReshape((_root, manifestPath) => {
      if (manifestPath !== undefined) writeFileSync(manifestPath, "{ not json");
    });
    expect(error).toContain("the staged manifest could not be read");
    expect(error).not.toContain(tmp);
  });

  test("a staged manifest for another extension id is a difference", async () => {
    const error = await prepareThenReshape((_root, manifestPath) => {
      editManifest(manifestPath, (m) => {
        m["id"] = "com.example.other";
      });
    });
    expect(error).toContain("id differs");
  });

  test("a staged manifest that widens the network grant is a difference found at accept", async () => {
    const error = await prepareThenReshape((_root, manifestPath) => {
      editManifest(manifestPath, (m) => {
        m["permissions"] = { network: [HOST, "evil.example"] };
      });
    });
    expect(error).toContain("permissions.network differs");
  });

  test("a staged package whose entry file is gone fails after the prompt", async () => {
    const error = await prepareThenReshape((root) => {
      rmSync(join(root, "dist", "index.js"));
    });
    expect(error).toContain("the staged package has no entry file");
  });

  test("an install that throws fails the row, whatever it throws", async () => {
    for (const thrower of [
      (): never => {
        throw new Error("disk full");
      },
      throwNonError,
    ]) {
      db.run("DELETE FROM connector_migration");
      const e = engine({ installVerified: async () => thrower() });
      await e.evaluate();
      const row = onlyRow();
      await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
        /the extension could not be installed/,
      );
      expect(getMigration(db, row.id)?.state).toBe("failed");
    }
  });

  test("a run approval that cannot be recorded undoes the install and fails the row", async () => {
    let broken = false;
    const base = grantEnv();
    const e = engine({
      env: {
        ...base,
        realpath: (p) => {
          if (broken) throw new Error("realpath unavailable");
          return base.realpath(p);
        },
      },
      installVerified: async (d, pkg, channel) => {
        const out = await installVerifiedRegistryPackage(d, pkg, channel);
        broken = true;
        return out;
      },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /the run approval could not be recorded/,
    );
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
  });

  test("a row that changed while it was being approved fails and undoes the install", async () => {
    let rowId = "";
    const e = engine({
      scheduler: {
        resume: () => {
          finishMigration(db, rowId, "declined", null, NOW);
        },
        syncableFor: (id) => registered.get(id),
      },
    });
    await e.evaluate();
    rowId = onlyRow().id;
    await expect(e.accept(rowId, consentThat(true, []))).rejects.toThrow(
      /changed while it was being approved; the install was undone/,
    );
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
  });

  test("a registration failure with a plain thrown value and an unremovable tree still fails the row", async () => {
    const e = engine({
      removeInstallTree: () => throwNonError(),
      scheduler: { resume: () => throwNonError(), syncableFor: (id) => registered.get(id) },
    });
    await e.evaluate();
    const row = onlyRow();
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /not-an-error-object; the install was undone/,
    );
    expect(getMigration(db, row.id)?.state).toBe("failed");
    expect(JSON.stringify(logs)).toContain("could not be removed from disk");
  });

  test("a leftover install that cannot be removed with a plain thrown value fails the row", async () => {
    const e = engine({ removeInstallTree: () => throwNonError() });
    await e.evaluate();
    const id = onlyRow().id;
    mkdirSync(join(tmp, "data", "extensions", EXT), { recursive: true });
    await expect(e.accept(id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED/,
    );
    expect(getMigration(db, id)?.state).toBe("failed");
  });

  test("a second legacy service bound to an already installed extension is prompted, then fails and leaves nothing installed", async () => {
    const other = { ...entry, legacyServiceId: "fixture_other" };
    const e = engine({ continuityTable: [entry, other] });
    await e.evaluate();
    const rows = listMigrations(db);
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((r) => r.legacyServiceId === LEGACY);
    const otherRow = rows.find((r) => r.legacyServiceId === "fixture_other");
    expect((await e.accept(firstRow?.id ?? "", consentThat(true, []))).state).toBe("approved");
    const seen: MigrationConsentPayload[] = [];
    await expect(e.accept(otherRow?.id ?? "", consentThat(true, seen))).rejects.toThrow(
      /the run approval could not be recorded/,
    );
    expect(seen).toHaveLength(1);
    expect(getMigration(db, otherRow?.id ?? "")?.state).toBe("failed");
    expect(listExtensions(db)).toEqual([]);
  });
});

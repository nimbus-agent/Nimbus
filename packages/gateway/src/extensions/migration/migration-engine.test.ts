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
import { buildTestRegistry } from "../registry/__fixtures__/build-test-registry.ts";
import type { BuiltinRegistryConfig } from "../registry/builtin-registry.ts";
import { installVerifiedRegistryPackage } from "../registry/install-from-registry.ts";
import { getRunGrant } from "../run-grant-store.ts";
import {
  awaitingApprovalReason,
  createMigrationEngine,
  type MigrationConsentPayload,
  type MigrationEngine,
  type MigrationEngineDeps,
  pauseLegacyService,
} from "./migration-engine.ts";
import { getMigration, listMigrations, recordMigrationPrepared } from "./migration-store.ts";

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
    expect(fetches.length).toBe(fetchesAfterFirst);
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
    expect(fetches.length).toBe(n);
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
    expect(errors.length).toBe(2);
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
    expect(fetches.length).toBe(n);
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
    expect(fetches.length).toBe(n);
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
    expect(fetches.length).toBe(n);
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

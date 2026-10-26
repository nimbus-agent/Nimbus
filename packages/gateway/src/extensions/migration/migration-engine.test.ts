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
import { publisherKeyFingerprint, signTrustStatement } from "@nimbus-dev/registry-format";
import pino from "pino";
import nacl from "tweetnacl";

import { listExtensions, setExtensionEnabled } from "../../automation/extension-store.ts";
import { createExtensionCredentialsResolver } from "../../connectors/extension-sync/extension-identity.ts";
import { getConnectorHealth, transitionHealth } from "../../connectors/health.ts";
import { upsertIndexedItem } from "../../index/item-store.ts";
import { createExtensionSyncRegistrar } from "../../platform/register-extension-sync.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { preflightRefusal, SyncScheduler } from "../../sync/scheduler.ts";
import { loadSchedulerState, setPaused } from "../../sync/scheduler-store.ts";
import { unboundSyncCapabilities } from "../../sync/sync-capabilities.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ContinuityEntry } from "../continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "../extension-run-grants.ts";
import { resolveExtensionManifestPath } from "../manifest.ts";
import { readPublisherKey, writePublisherKey } from "../publisher-keys.ts";
import { buildTestRegistry } from "../registry/__fixtures__/build-test-registry.ts";
import type { BuiltinRegistryConfig } from "../registry/builtin-registry.ts";
import { installVerifiedRegistryPackage } from "../registry/install-from-registry.ts";
import { deleteRunGrant, getRunGrant, upsertRunGrant } from "../run-grant-store.ts";
import { computeExtensionTreeDigest } from "../tree-digest.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
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
  recordMigrationFailed,
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
/** The fake scheduler's pauses: [service id, reason]. */
let pausedCalls: Array<[string, string | undefined]>;
/** What the fake registered syncable's `preflight` answers (the forced-canConfine seam). */
let preflightAnswer: () => string | null;
let refreshed: string[];
let logs: unknown[];
/** The fake scheduler's registrations: service id -> extension id. */
let registered: Map<string, string>;
/** Where the fake registrar registers a live, granted extension's sync. */
let registerMode: "legacy" | "none" | "ext";
const CODE_ID = "ext_com_example_reader";
const extraCleanups: Array<() => Promise<void> | void> = [];

// The folder is wiped on every rebuild, so the sequence is carried here: a rebuild re-publishes the
// registry, and re-publishing at an accepted sequence with different content is refused (V76).
let registrySequence = 0;

async function buildRegistry(extra: Record<string, unknown> = MANIFEST_EXTRA): Promise<void> {
  rmSync(registryDir, { recursive: true, force: true });
  registrySequence += 1;
  const built = await buildTestRegistry(registryDir, {
    id: EXT,
    versions: [{ version: "1.0.0" }],
    publisherId: "nimbus",
    manifestExtra: extra,
    sequence: registrySequence,
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
  pausedCalls = [];
  preflightAnswer = () => null;
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

/** The fake scheduler's registered syncable: only its `preflight` is read by the engine. */
function fakeSyncableFor(id: string): { preflight: () => string | null } | undefined {
  return registered.has(id) ? { preflight: () => preflightAnswer() } : undefined;
}

function fakePause(id: string, reason?: string): void {
  pausedCalls.push([id, reason]);
  setPaused(db, id, true);
  transitionHealth(db, id, { type: "paused", ...(reason === undefined ? {} : { reason }) });
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
      pause: fakePause,
      syncableFor: fakeSyncableFor,
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

  test("the default bundled predicate is the real bundled registry: a still-bundled entry is skipped", async () => {
    const { isBundledConnector: _p, ...rest } = deps();
    await createMigrationEngine({
      ...rest,
      continuityTable: [{ ...entry, legacyServiceId: "mercury" }],
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
      `Fixture Reader moved to an extension — run \`nimbus connector migrate accept ${row.id}\` or answer it on the Marketplace page of the desktop app (Pending migrations)`,
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

  test("an extension id installed for another entry -> failed, never telling the owner to remove it", async () => {
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
    // Bound to the FIRST entry (fixture_reader), so not to this one: the not-official wording.
    expect(row?.error).toBe(
      `${EXT} already installed, but not as the official Fixture Reader extension this release moves Fixture Reader to; your Fixture Reader items are untouched — inspect it with \`nimbus extension list\``,
    );
    expect(getConnectorHealth(db, "fixture_other").lastError).toBe(
      `${row?.error ?? ""} — run \`nimbus connector migrate retry\``,
    );
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
    let prompted: () => void = () => {};
    const asked = new Promise<void>((r) => (prompted = r));
    const first = e.accept(row.id, () => {
      prompted();
      return new Promise<boolean>((r) => (release = r));
    });
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_BUSY/,
    );
    expect(() => e.decline(row.id)).toThrow(/ERR_EXTENSION_MIGRATION_BUSY/);
    // The first accept reads the Vault (C11) before it prompts: answer only once it is prompting.
    await asked;
    await expect(e.accept(row.id, consentThat(true, []))).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_BUSY/,
    );
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
      fromRenderer: false,
    });
  });

  // The audit row the executor gate actually writes is asserted over a real IPC connection in
  // `ipc/migration-accept-kind.test.ts`; this pins the engine half and that redaction keeps it.
  test("I46: fromRenderer records the caller's origin as given, and survives audit redaction", async () => {
    const e = engine();
    await e.evaluate();
    const seen: MigrationConsentPayload[] = [];
    await e.accept(onlyRow().id, consentThat(false, seen), { fromRenderer: true }).catch(() => {});
    expect(seen.map((p) => p.fromRenderer)).toEqual([true]);
    const { redactAuditPayload } = await import("../../audit/format-audit-payload.ts");
    expect(redactAuditPayload(seen[0], 8192)).toContain('"fromRenderer":true');
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
      "Readwise moved to an extension — run `nimbus connector migrate accept abc` or answer it on the Marketplace page of the desktop app (Pending migrations)",
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
        pause: fakePause,
        syncableFor: fakeSyncableFor,
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
        pause: fakePause,
        syncableFor: fakeSyncableFor,
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

    // Accept itself records the pause BEFORE it answers, so `migrate accept`'s own
    // `connector.listStatus` read already sees it (never "carried over").
    expect(resumed).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const atAccept = getConnectorHealth(db, LEGACY);
    expect(atAccept.state).toBe("paused");
    expect(atAccept.lastError).toContain(`sandbox cannot confine this extension: ${REASON}`);
    expect(atAccept.lastError).toContain(`nimbus connector resume ${LEGACY}`);

    // `connector resume` before the sandbox is fixed: the first run's preflight pauses it again,
    // before any spawn, and records byte-for-byte the reason accept recorded.
    sched.resume(LEGACY);
    expect(getConnectorHealth(db, LEGACY).state).not.toBe("paused");
    await sched.forceSync(LEGACY).catch(() => undefined);
    expect(meshCalls).toEqual([]);
    expect(egress).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toContain(`sandbox cannot confine this extension: ${REASON}`);
    expect(health.lastError).toContain(`nimbus connector resume ${LEGACY}`);
    expect(health.lastError).toBe(atAccept.lastError);
  });

  test("accept resumes when the registered syncable's preflight passes", async () => {
    let preflights = 0;
    preflightAnswer = () => {
      preflights += 1;
      return null;
    };
    const e = engine();
    await e.evaluate();
    const row = await e.accept(onlyRow().id, consentThat(true, []));
    expect(row.state).toBe("approved");
    expect(preflights).toBe(1);
    expect(resumed).toEqual([LEGACY]);
    expect(pausedCalls).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(0);
  });

  test("accept pauses with the preflight's reason, verbatim, instead of resuming", async () => {
    const REASON = `sandbox cannot confine this extension: no helper — fix it (see \`nimbus doctor\`), then run \`nimbus connector resume ${LEGACY}\``;
    preflightAnswer = () => REASON;
    const e = engine();
    await e.evaluate();
    const row = await e.accept(onlyRow().id, consentThat(true, []));
    expect(row.state).toBe("approved");
    expect(resumed).toEqual([]);
    expect(pausedCalls).toEqual([[LEGACY, REASON]]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(REASON);
  });

  test("a preflight that throws pauses (fail closed)", async () => {
    preflightAnswer = () => {
      throw new Error("grant vanished");
    };
    const e = engine();
    await e.evaluate();
    const row = await e.accept(onlyRow().id, consentThat(true, []));
    expect(row.state).toBe("approved");
    expect(resumed).toEqual([]);
    // The scheduler's own wording for a throwing preflight (`sync/scheduler.ts` runJob).
    expect(pausedCalls).toEqual([[LEGACY, "preflight failed: grant vanished"]]);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(getConnectorHealth(db, LEGACY).lastError).toBe("preflight failed: grant vanished");
  });

  test("a throwing preflight: accept records exactly what the real scheduler's refusal records", async () => {
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
      { appendSyncEgress: () => undefined },
    );
    extraCleanups.push(() => sched.stop());
    let syncs = 0;
    const e = engine({
      scheduler: sched,
      extensionSync: {
        refresh: (id) => {
          refreshed.push(id);
          sched.unregister(LEGACY);
          if (!listExtensions(db).some((r) => r.id === id) || getRunGrant(db, id) === null) return;
          sched.register({
            serviceId: LEGACY,
            defaultIntervalMs: 600_000,
            initialSyncDepthDays: 30,
            preflight: () => {
              throw new Error("grant vanished");
            },
            sync: async () => {
              syncs += 1;
              throw new Error("premise: a refused run never syncs");
            },
          });
        },
      },
    });
    await e.evaluate();
    await e.accept(onlyRow().id, consentThat(true, []));
    const atAccept = getConnectorHealth(db, LEGACY);
    expect(atAccept.state).toBe("paused");
    expect(atAccept.lastError).toBe("preflight failed: grant vanished");
    sched.resume(LEGACY);
    await sched.forceSync(LEGACY).catch(() => undefined);
    expect(syncs).toBe(0);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(atAccept.lastError);
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
    let prompted: () => void = () => {};
    const asked = new Promise<void>((r) => (prompted = r));
    const accepting = e.accept(row.id, () => {
      prompted();
      return new Promise<boolean>((r) => (release = r));
    });
    const n = fetches.length;
    // Before the prompt (the accept is reading the Vault, C11) and while it is open.
    await e.evaluate();
    expect(fetches).toHaveLength(n);
    await asked;
    await e.evaluate();
    expect(fetches).toHaveLength(n);
    expect(getMigration(db, row.id)?.state).toBe("awaiting_approval");
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
        // Only evaluate's read of the legacy credential is held; accept's publisher-key read (C11)
        // goes through.
        if (held && key === LEGACY_KEY) await new Promise<void>((r) => (open = r));
        return vault.get(key);
      },
    };
    const e = engine({ vault: slow });
    held = true;
    const evaluating = e.evaluate();
    let release: (v: boolean) => void = () => {};
    let prompted: () => void = () => {};
    const asked = new Promise<void>((r) => (prompted = r));
    const accepting = e.accept(row.id, () => {
      prompted();
      return new Promise<boolean>((r) => (release = r));
    });
    const n = fetches.length;
    open();
    await evaluating;
    expect(fetches).toHaveLength(n);
    held = false;
    await asked;
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
        pause: fakePause,
        syncableFor: fakeSyncableFor,
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
      scheduler: {
        resume: () => throwNonError(),
        pause: fakePause,
        syncableFor: fakeSyncableFor,
      },
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

  test("a second legacy service bound to an already installed extension fails before any prompt and leaves the first install alone", async () => {
    const other = { ...entry, legacyServiceId: "fixture_other" };
    const e = engine({ continuityTable: [entry, other] });
    await e.evaluate();
    const rows = listMigrations(db);
    expect(rows).toHaveLength(2);
    const firstRow = rows.find((r) => r.legacyServiceId === LEGACY);
    const otherRow = rows.find((r) => r.legacyServiceId === "fixture_other");
    expect((await e.accept(firstRow?.id ?? "", consentThat(true, []))).state).toBe("approved");
    const installedBefore = listExtensions(db).map((r) => r.id);
    expect(installedBefore).toEqual([EXT]);
    const grantBefore = getRunGrant(db, EXT);
    expect(grantBefore).not.toBeNull();
    const seen: MigrationConsentPayload[] = [];
    const err = await thrownBy(() => e.accept(otherRow?.id ?? "", consentThat(true, seen)));
    expect(err?.message).toContain(`${EXT} already installed, but not as the official`);
    expect(err?.message).not.toContain("remove");
    // No prompt was raised for a question that cannot succeed.
    expect(seen).toEqual([]);
    expect(getMigration(db, otherRow?.id ?? "")?.state).toBe("failed");
    // The first migration's extension and run grant survive, and it stays approved.
    expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
    expect(getRunGrant(db, EXT)).toEqual(grantBefore);
    expect(getMigration(db, firstRow?.id ?? "")?.state).toBe("approved");
  });
});

describe("Task 7.4: an extension that is already installed (replaces ruling B9)", () => {
  const APPROVE_HINT = `run \`nimbus extension approve ${EXT}\` to resume sync`;

  /** The owner's existing items under the legacy id, which no branch here may touch. */
  function seedLegacyItems(): void {
    for (const externalId of ["201", "202"]) {
      upsertIndexedItem(db, {
        service: LEGACY,
        type: "highlight",
        externalId,
        title: `kept ${externalId}`,
        modifiedAt: 1,
        syncedAt: 1,
      });
    }
  }

  function legacyItemCount(): number {
    const r = db.query("SELECT COUNT(*) AS n FROM item WHERE service = ?").get(LEGACY) as {
      n: number;
    };
    return r.n;
  }

  /**
   * The extension installed and approved with the legacy credential — what the owner has after
   * `extension install` + `extension approve` of the official package. Reached through a real
   * accept; the migration row it leaves is then removed, as if it had never existed.
   */
  async function installedAndApproved(): Promise<void> {
    const e = engine();
    await e.evaluate();
    await e.accept(onlyRow().id, consentThat(true, []));
    db.run("DELETE FROM connector_migration");
    pauseLegacyService(db, LEGACY, "seed", NOW);
    fetches = [];
    resumed = [];
    refreshed = [];
  }

  /** An awaiting row for the installed extension, as a prepare before the install left it. */
  function awaitingRow(): string {
    recordMigrationPrepared(
      db,
      {
        id: "pending-1",
        legacyServiceId: LEGACY,
        extensionId: EXT,
        version: "1.0.0",
        treeDigest: listExtensions(db).find((r) => r.id === EXT)?.tree_digest ?? "",
        stagePath: join(stageRootOf("pending-1"), "pkg"),
      },
      NOW,
    );
    return "pending-1";
  }

  function makeGrantStale(kind: "credentials" | "digest" | "missing"): void {
    const grant = getRunGrant(db, EXT);
    if (grant === null) throw new Error("premise: a run grant");
    if (kind === "missing") {
      deleteRunGrant(db, EXT);
      return;
    }
    upsertRunGrant(
      db,
      kind === "credentials"
        ? {
            ...grant,
            // C10: an install approved before the binding existed stores the extension's own key.
            credentials_json: `{"token":{"env":"FIXTURE_TOKEN","vaultKey":"ext.${CODE_ID}.token"}}`,
          }
        : { ...grant, tree_digest: "0".repeat(64) },
    );
  }

  test("installed + bound + matching grant -> approved, resumed, no fetch, no prompt (evaluate)", async () => {
    await installedAndApproved();
    seedLegacyItems();
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("approved");
    expect(row.error).toBeNull();
    expect(row.stagePath).toBeNull();
    expect(fetches).toEqual([]);
    expect(resumed).toEqual([LEGACY]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(0);
    expect(legacyItemCount()).toBe(2);
    // Terminal: the next evaluation leaves it alone.
    await engine().evaluate();
    expect(onlyRow()).toEqual(row);
    expect(fetches).toEqual([]);
  });

  test("a failed row left by the B9 wording is finished approved by the next evaluate", async () => {
    await installedAndApproved();
    recordMigrationFailed(
      db,
      {
        id: "old-1",
        legacyServiceId: LEGACY,
        extensionId: EXT,
        error: `${EXT} already installed — remove it, then \`nimbus connector migrate retry\``,
      },
      NOW,
    );
    await engine().evaluate();
    const row = onlyRow();
    expect(row.id).toBe("old-1");
    expect(row.state).toBe("approved");
    expect(fetches).toEqual([]);
    expect(resumed).toEqual([LEGACY]);
  });

  test("installed + bound + matching grant -> accept finishes approved with no prompt and no stage", async () => {
    await installedAndApproved();
    const id = awaitingRow();
    // M6: prepared for another release — the row must end up naming what is INSTALLED.
    db.run("UPDATE connector_migration SET version = ?, tree_digest = ? WHERE id = ?", [
      "0.9.0",
      "a".repeat(64),
      id,
    ]);
    mkdirSync(stageRootOf(id), { recursive: true });
    const grantBefore = getRunGrant(db, EXT);
    const seen: MigrationConsentPayload[] = [];
    const out = await engine().accept(id, consentThat(true, seen));
    expect(out.state).toBe("approved");
    const installedRow = listExtensions(db).find((r) => r.id === EXT);
    expect(out.version).toBe(installedRow?.version ?? "");
    expect(out.treeDigest).toBe(installedRow?.tree_digest ?? "");
    expect(seen).toEqual([]);
    expect(fetches).toEqual([]);
    expect(resumed).toEqual([LEGACY]);
    expect(existsSync(stageRootOf(id))).toBe(false);
    expect(getRunGrant(db, EXT)).toEqual(grantBefore);
  });

  test("already-installed accept pauses with the confine reason", async () => {
    await installedAndApproved();
    const id = awaitingRow();
    const REASON = `sandbox cannot confine this extension: no bwrap — fix it (see \`nimbus doctor\`), then run \`nimbus connector resume ${LEGACY}\``;
    preflightAnswer = () => REASON;
    const out = await engine().accept(id, consentThat(true, []));
    expect(out.state).toBe("approved");
    expect(resumed).toEqual([]);
    expect(pausedCalls).toEqual([[LEGACY, REASON]]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(REASON);
  });

  test("already-installed evaluate pauses with the confine reason too", async () => {
    await installedAndApproved();
    const REASON = "sandbox cannot confine this extension: no helper";
    preflightAnswer = () => REASON;
    await engine().evaluate();
    expect(onlyRow().state).toBe("approved");
    expect(resumed).toEqual([]);
    expect(pausedCalls).toEqual([[LEGACY, REASON]]);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(REASON);
  });

  test("already-installed evaluate before the registrar registers: the later registration pauses an unconfinable sync", async () => {
    await installedAndApproved();
    const REASON = "the sandbox helper is not installed";
    const sched = new SyncScheduler({
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
    });
    extraCleanups.push(() => sched.stop());
    const meshCalls: string[] = [];
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
    // Nothing is registered yet, so evaluate's finish has no preflight to ask and resumes.
    await engine({ extensionSync: registrar, scheduler: sched }).evaluate();
    expect(onlyRow().state).toBe("approved");
    expect(sched.syncableFor(LEGACY)).toBeUndefined();
    expect(getConnectorHealth(db, LEGACY).state).not.toBe("paused");

    registrar.refresh(EXT);
    const syncable = sched.syncableFor(LEGACY);
    if (syncable === undefined) throw new Error("premise: registered under the legacy id");
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toContain(`sandbox cannot confine this extension: ${REASON}`);
    expect(health.lastError).toBe(preflightRefusal(syncable) ?? "premise: the preflight refuses");
    expect(meshCalls).toEqual([]);
  });

  test("M1: installed files changed on disk since approval -> stale, not approved", async () => {
    await installedAndApproved();
    const installPath = listExtensions(db).find((r) => r.id === EXT)?.install_path ?? "";
    writeFileSync(join(installPath, "dist", "index.js"), "export const changed = 1;\n");
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain(`\`nimbus extension approve ${EXT}\``);
    expect(resumed).toEqual([]);
    expect(fetches).toEqual([]);
  });

  const DISABLED = `${EXT} is installed but disabled — run \`nimbus extension enable ${EXT}\` to resume sync`;

  test("M4: bound + current grant but disabled -> approved, legacy paused naming extension enable (evaluate)", async () => {
    await installedAndApproved();
    setExtensionEnabled(db, EXT, false);
    await engine().evaluate();
    expect(onlyRow().state).toBe("approved");
    expect(resumed).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(DISABLED);
    expect(fetches).toEqual([]);
  });

  test("M4: bound + current grant but disabled -> accept approves with no prompt, legacy paused naming enable", async () => {
    await installedAndApproved();
    setExtensionEnabled(db, EXT, false);
    const id = awaitingRow();
    const seen: MigrationConsentPayload[] = [];
    expect((await engine().accept(id, consentThat(true, seen))).state).toBe("approved");
    expect(seen).toEqual([]);
    expect(resumed).toEqual([]);
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(DISABLED);
  });

  for (const kind of ["credentials", "digest", "missing"] as const) {
    test(`installed + bound, ${kind} grant stale -> failed naming extension approve; items untouched`, async () => {
      await installedAndApproved();
      seedLegacyItems();
      makeGrantStale(kind);
      await engine().evaluate();
      const row = onlyRow();
      expect(row.state).toBe("failed");
      expect(row.error).toContain(`\`nimbus extension approve ${EXT}\``);
      expect(row.error).not.toContain("remove");
      expect(fetches).toEqual([]);
      expect(resumed).toEqual([]);
      // Ends with the stale-grant hint, so the re-approval itself resumes sync (ruling B39).
      const health = getConnectorHealth(db, LEGACY);
      expect(health.state).toBe("paused");
      expect(health.lastError?.endsWith(APPROVE_HINT)).toBe(true);
      expect(legacyItemCount()).toBe(2);
      expect(await vault.get(LEGACY_KEY)).toBe(TOKEN);
      expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
    });
  }

  test("installed + bound, stale grant -> accept fails before the prompt naming extension approve", async () => {
    await installedAndApproved();
    makeGrantStale("credentials");
    const id = awaitingRow();
    const seen: MigrationConsentPayload[] = [];
    const err = await thrownBy(() => engine().accept(id, consentThat(true, seen)));
    expect(err?.message).toMatch(/^ERR_EXTENSION_MIGRATION_FAILED: /);
    expect(err?.message).toContain(`\`nimbus extension approve ${EXT}\``);
    expect(err?.message).not.toContain("remove");
    expect(seen).toEqual([]);
    expect(getMigration(db, id)?.state).toBe("failed");
    expect(getConnectorHealth(db, LEGACY).lastError?.endsWith(APPROVE_HINT)).toBe(true);
    expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
  });

  test("installed, not bound -> failed without 'remove it'; items untouched", async () => {
    await installedAndApproved();
    seedLegacyItems();
    // Installed from another source (an owner registry with another root): not this entry's binding.
    db.run("UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", ["f".repeat(32), EXT]);
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain(`${EXT} already installed`);
    expect(row.error).toContain("`nimbus extension list`");
    expect(row.error).not.toContain("remove");
    expect(fetches).toEqual([]);
    expect(resumed).toEqual([]);
    expect(getConnectorHealth(db, LEGACY).state).toBe("paused");
    expect(legacyItemCount()).toBe(2);
    expect(await vault.get(LEGACY_KEY)).toBe(TOKEN);
    expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
  });

  test("installed with a manifest that no longer verifies is not bound", async () => {
    await installedAndApproved();
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = ?", ["0".repeat(64), EXT]);
    await engine().evaluate();
    const row = onlyRow();
    expect(row.state).toBe("failed");
    expect(row.error).toContain("`nimbus extension list`");
    expect(fetches).toEqual([]);
  });

  test("installed, not bound -> accept fails before the prompt without 'remove it'", async () => {
    await installedAndApproved();
    db.run("UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", ["f".repeat(32), EXT]);
    const id = awaitingRow();
    const seen: MigrationConsentPayload[] = [];
    const err = await thrownBy(() => engine().accept(id, consentThat(true, seen)));
    expect(err?.message).toContain(`${EXT} already installed`);
    expect(err?.message).not.toContain("remove");
    expect(seen).toEqual([]);
    expect(getMigration(db, id)?.state).toBe("failed");
  });
});

describe("Task 7.4 (C11): accept re-checks the Vault's publisher key before the prompt", () => {
  test("accept refuses a Vault publisher-key conflict before consent; Vault unchanged", async () => {
    const e = engine();
    await e.evaluate();
    const id = onlyRow().id;
    // Between prepare and accept the Vault learned a different key for publisher "nimbus".
    const other = new Uint8Array(32).fill(5);
    await writePublisherKey(vault, "nimbus", other);
    const seen: MigrationConsentPayload[] = [];
    const err = await thrownBy(() => e.accept(id, consentThat(true, seen)));
    expect(err?.message).toBe(
      'ERR_EXTENSION_MIGRATION_FAILED: the Vault already holds a different key for publisher "nimbus"; refusing to replace it',
    );
    expect(seen).toEqual([]);
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(Buffer.from((await readPublisherKey(vault, "nimbus")) ?? []).equals(other)).toBe(true);
    expect(getMigration(db, id)?.state).toBe("failed");
  });

  test("a key the publisher rotated to from the Vault's key is no conflict (spec R5)", async () => {
    const e = engine();
    await e.evaluate();
    const oldSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 77);
    const oldKey = Buffer.from(nacl.sign.keyPair.fromSeed(oldSeed).publicKey);
    await writePublisherKey(vault, "nimbus", oldKey);
    const rotation = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: oldKey.toString("base64"),
        publisherId: "nimbus",
        fromKey: oldKey.toString("base64"),
        toKey: entry.publisherKey,
      },
      oldSeed,
    );
    const feedRoot = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
    recordTrustStatements(db, [rotation], { kind: "feed", nimbusRootKey: feedRoot }, 1);
    expect((await e.accept(onlyRow().id, consentThat(true, []))).state).toBe("approved");
  });

  test("the same key already in the Vault is no conflict", async () => {
    const e = engine();
    await e.evaluate();
    await writePublisherKey(vault, "nimbus", Buffer.from(entry.publisherKey, "base64"));
    expect((await e.accept(onlyRow().id, consentThat(true, []))).state).toBe("approved");
  });

  test("M3: a conflicting key the Vault learns while the prompt is open fails after consent, nothing installed", async () => {
    const e = engine();
    await e.evaluate();
    const id = onlyRow().id;
    const other = new Uint8Array(32).fill(6);
    const seen: MigrationConsentPayload[] = [];
    const err = await thrownBy(() =>
      e.accept(id, async (p) => {
        seen.push(p);
        await writePublisherKey(vault, "nimbus", other);
        return true;
      }),
    );
    expect(err?.message).toBe(
      'ERR_EXTENSION_MIGRATION_FAILED: the Vault already holds a different key for publisher "nimbus"; refusing to replace it',
    );
    expect(seen).toHaveLength(1);
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    expect(Buffer.from((await readPublisherKey(vault, "nimbus")) ?? []).equals(other)).toBe(true);
    expect(getMigration(db, id)?.state).toBe("failed");
  });
});

describe("Task 7.4 (C12): the extension runtime is off", () => {
  const RUNTIME_OFF =
    "Fixture Reader moved to an extension, and the extension runtime is off (`[extensions] runtime = false`) — turn it on, then run `nimbus connector migrate retry`";

  test("runtime off -> no fetch, no row, paused reason names [extensions] runtime; then runtime on + retry proceeds", async () => {
    await engine({ runtimeEnabled: false }).evaluate();
    expect(fetches).toEqual([]);
    expect(listMigrations(db)).toEqual([]);
    expect(loadSchedulerState(db, LEGACY)?.paused).toBe(1);
    const health = getConnectorHealth(db, LEGACY);
    expect(health.state).toBe("paused");
    expect(health.lastError).toBe(RUNTIME_OFF);

    await engine({ runtimeEnabled: false }).retry();
    expect(fetches).toEqual([]);
    expect(listMigrations(db)).toEqual([]);

    await engine().retry();
    expect(onlyRow().state).toBe("awaiting_approval");
    expect(fetches.length).toBeGreaterThan(0);
  });

  test("runtime off with no legacy credential pauses nothing", async () => {
    await vault.delete(LEGACY_KEY);
    await engine({ runtimeEnabled: false }).evaluate();
    expect(loadSchedulerState(db, LEGACY)).toBeNull();
  });

  test("runtime off leaves a declined row's reason alone at boot", async () => {
    const e = engine();
    await e.evaluate();
    e.decline(onlyRow().id);
    const before = getConnectorHealth(db, LEGACY).lastError;
    await engine({ runtimeEnabled: false }).evaluate();
    expect(getConnectorHealth(db, LEGACY).lastError).toBe(before);
    expect(onlyRow().state).toBe("declined");
  });
});

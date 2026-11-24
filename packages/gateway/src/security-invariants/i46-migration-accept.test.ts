import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { reachRunner, read } from "../../test/helpers/security-invariants.ts";
import { listExtensions } from "../automation/extension-store.ts";
import { transitionHealth } from "../connectors/health.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import { resolveExtensionManifestPath } from "../extensions/manifest.ts";
import {
  createMigrationEngine,
  type MigrationEngine,
  type MigrationEngineDeps,
} from "../extensions/migration/migration-engine.ts";
import {
  finishMigration,
  getMigration,
  listMigrations,
} from "../extensions/migration/migration-store.ts";
import { buildTestRegistry } from "../extensions/registry/__fixtures__/build-test-registry.ts";
import type { BuiltinRegistryConfig } from "../extensions/registry/builtin-registry.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import { dispatchMigrationRpc } from "../ipc/migration-rpc.ts";
import { RpcMethodError } from "../ipc/server/rpc-error.ts";
import { setPaused } from "../sync/scheduler-store.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * I46. Every behavioural test here drives the path the desktop uses — `migration.accept` through
 * `dispatchMigrationRpc`, the handler the bridge's `rpc_call` reaches — over a REAL migration
 * engine, a real signed fixture registry configured as the built-in one, and a real index. The
 * fixture's legacy id is not a bundled connector (the engine skips a bundled one entirely).
 */
describe("I46 — a renderer can create an extension run grant only through migration.accept, by id, under the baked whitelist", () => {
  const BRIDGE = "packages/ui/src-tauri/src/gateway_bridge.rs";
  const EXT = "com.example.reader";
  const LEGACY = "fixture_reader";
  const LEGACY_KEY = "fixture_reader.token";
  const HOST = "reader.example";
  const BUILTIN_URL = "https://registry.nimbus.test/";
  const NOW = Date.parse("2026-10-21T12:00:00Z");

  let tmp: string;
  let registryDir: string;
  let builtin: BuiltinRegistryConfig;
  let entry: ContinuityEntry;
  let db: Database;
  let vault: NimbusVault;
  /** The fake scheduler's registrations: service id -> extension id. */
  let registered: Map<string, string>;

  beforeEach(async () => {
    tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i46-")));
    registryDir = join(tmp, "official");
    const built = await buildTestRegistry(registryDir, {
      id: EXT,
      versions: [{ version: "1.0.0" }],
      publisherId: "nimbus",
      manifestExtra: {
        name: "Fixture Reader",
        permissions: { network: [HOST] },
        credentials: { token: { env: "FIXTURE_TOKEN" } },
        sync: { contract: "1", intervalSeconds: 600, itemTypes: ["highlight", "book"] },
      },
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
    db = openMemoryIndexDatabase();
    vault = createMemoryVault();
    await vault.set(LEGACY_KEY, "I46-SECRET-TOKEN-VALUE");
    registered = new Map();
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function engineWith(over: Partial<MigrationEngineDeps> = {}): MigrationEngine {
    return createMigrationEngine({
      db,
      vault,
      dataDir: join(tmp, "data"),
      extensionsDir: join(tmp, "data", "extensions"),
      fetch: {
        fetchFn: async (url) => {
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
      env: {
        platform: process.platform,
        protectedRoots: [join(tmp, "data"), join(tmp, "config")],
        runtimeReadPaths: [join(tmp, "bun-bin")],
        realpath: (p) => realpathSync.native(p),
      },
      runtimeEnabled: true,
      sandbox: reachRunner(() => null),
      extensionSync: {
        refresh: (id) => {
          for (const [k, v] of registered) if (v === id) registered.delete(k);
          const live = listExtensions(db).some((r) => r.id === id) && getRunGrant(db, id) !== null;
          if (!live) return;
          for (const e of [entry]) if (e.extensionId === id) registered.set(e.legacyServiceId, id);
        },
      },
      scheduler: {
        resume: (id) => {
          setPaused(db, id, false);
          transitionHealth(db, id, { type: "resumed" });
        },
        pause: (id, reason) => {
          setPaused(db, id, true);
          transitionHealth(db, id, { type: "paused", ...(reason === undefined ? {} : { reason }) });
        },
        syncableFor: (id) => (registered.has(id) ? {} : undefined),
      },
      now: () => NOW,
      ...over,
    });
  }

  async function preparedRowId(e: MigrationEngine = engineWith()): Promise<string> {
    await e.evaluate();
    const rows = listMigrations(db);
    expect(rows.map((r) => r.state)).toEqual(["awaiting_approval"]);
    return rows[0]?.id ?? "";
  }

  interface RendererAccept {
    readonly asked: Array<{ type: string; payload: Record<string, unknown> }>;
    readonly value?: Record<string, unknown>;
    readonly error?: RpcMethodError;
  }

  /** `migration.accept` exactly as the desktop sends it, answered "yes" by the owner. */
  async function acceptAsRenderer(
    e: MigrationEngine,
    params: Record<string, unknown>,
  ): Promise<RendererAccept> {
    const asked: Array<{ type: string; payload: Record<string, unknown> }> = [];
    try {
      const out = await dispatchMigrationRpc("migration.accept", params, {
        engine: e,
        ownerGate: async (a) => {
          asked.push(a);
          return true;
        },
        fromRenderer: true,
      });
      return { asked, value: (out as { value: Record<string, unknown> }).value };
    } catch (err) {
      if (err instanceof RpcMethodError) return { asked, error: err };
      throw err;
    }
  }

  function expectRefusedBeforeThePrompt(out: RendererAccept, code: RegExp): void {
    expect(out.error?.message).toMatch(code);
    expect(out.asked).toEqual([]);
    expect(listExtensions(db)).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
  }

  /** Rewrites the staged manifest and re-stamps the row's digest, so the stage still "matches". */
  function reshapeStagedManifest(id: string, edit: (m: Record<string, unknown>) => void): void {
    const stage = getMigration(db, id)?.stagePath ?? "";
    const manifestPath = resolveExtensionManifestPath(stage);
    if (manifestPath === undefined) throw new Error("premise: a staged manifest");
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    edit(m);
    writeFileSync(manifestPath, JSON.stringify(m));
    db.run("UPDATE connector_migration SET tree_digest = ? WHERE id = ?", [
      computeExtensionTreeDigest(stage),
      id,
    ]);
  }

  // ---- the renderer surface ------------------------------------------------------------------

  test("the bridge exposes migration.list and migration.accept, and no other migration or install verb", async () => {
    const rust = await read(BRIDGE);
    expect(rust).toMatch(/^\s*"migration\.list",\s*$/m);
    expect(rust).toMatch(/^\s*"migration\.accept",\s*$/m);
    const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
    const list = rust.slice(start, rust.indexOf("];", start));
    const migration = [...list.matchAll(/"(migration\.[A-Za-z]+)"/g)].map((m) => m[1]);
    expect(migration).toEqual(["migration.accept", "migration.list"]);
    for (const m of [
      "migration.decline",
      "migration.retry",
      "extension.install",
      "extension.approveRun",
    ]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"${m.replace(".", "\\.")}",\\s*$`, "m"));
      expect(rust).toContain(`assert!(!is_method_allowed("${m}"));`);
    }
    expect(rust).toContain('assert!(is_method_allowed("migration.list"));');
    expect(rust).toContain('assert!(is_method_allowed("migration.accept"));');
    expect(rust).toMatch(/assert_eq!\s*\(\s*ALLOWED_METHODS\.len\(\),\s*141\s*\)/);
  });

  // ---- the positive control ------------------------------------------------------------------

  test("a gateway-prepared row is accepted with ONE extension.migrate prompt to the caller, and the record says it came from the renderer", async () => {
    const id = await preparedRowId();
    const out = await acceptAsRenderer(engineWith(), { id });
    expect(out.error).toBeUndefined();
    expect(out.asked.map((a) => a.type)).toEqual(["extension.migrate"]);
    expect(out.asked[0]?.payload["fromRenderer"]).toBe(true);
    expect(out.value?.["state"]).toBe("approved");
    expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
  });

  test("accept reads the id and nothing else: a client cannot choose the package, the grant or the record", async () => {
    const id = await preparedRowId();
    const out = await acceptAsRenderer(engineWith(), {
      id,
      extensionId: "com.evil.other",
      registry: "https://evil.example/",
      permissions: { network: ["evil.example"], read: ["/"], write: ["/"] },
      credentials: { token: "openai.api_key" },
      fromRenderer: false,
    });
    expect(out.error).toBeUndefined();
    const payload = out.asked[0]?.payload ?? {};
    expect(payload["extensionId"]).toBe(EXT);
    expect(JSON.stringify(payload)).not.toContain("evil");
    // The audit field is the gateway's, not the caller's.
    expect(payload["fromRenderer"]).toBe(true);
    expect(getRunGrant(db, EXT)?.credentials_json).toBe(
      `{"token":{"env":"FIXTURE_TOKEN","vaultKey":"${LEGACY_KEY}"}}`,
    );
  });

  // ---- the whitelist ---------------------------------------------------------------------------

  test("an unknown id is refused", async () => {
    await preparedRowId();
    const out = await acceptAsRenderer(engineWith(), { id: "not-a-migration" });
    expectRefusedBeforeThePrompt(out, /^ERR_EXTENSION_MIGRATION_NOT_FOUND:/);
  });

  test.each(["failed", "approved", "declined"] as const)(
    "a row in %s is refused",
    async (state) => {
      const id = await preparedRowId();
      expect(finishMigration(db, id, state, state === "failed" ? "x" : null, NOW)).toBe(true);
      const out = await acceptAsRenderer(engineWith(), { id });
      expectRefusedBeforeThePrompt(out, /^ERR_EXTENSION_MIGRATION_NOT_PENDING:/);
    },
  );

  test("a stage whose tree no longer matches the row's digest is refused", async () => {
    const id = await preparedRowId();
    const stage = getMigration(db, id)?.stagePath ?? "";
    writeFileSync(join(stage, "dist", "index.js"), "export const pwned = 1;\n");
    const out = await acceptAsRenderer(engineWith(), { id });
    expectRefusedBeforeThePrompt(out, /^ERR_EXTENSION_MIGRATION_FAILED: .*digest/);
    expect(getMigration(db, id)?.state).toBe("failed");
  });

  test.each([
    [
      "permissions",
      "permissions.network",
      (m: Record<string, unknown>) => {
        m["permissions"] = { network: [HOST, "evil.example"] };
      },
    ],
    [
      "credential mapping",
      "credentials",
      (m: Record<string, unknown>) => {
        m["credentials"] = { token: { env: "FIXTURE_TOKEN" }, other: { env: "OTHER" } };
      },
    ],
    [
      "item types",
      "sync.itemTypes",
      (m: Record<string, unknown>) => {
        m["sync"] = { contract: "1", intervalSeconds: 600, itemTypes: ["highlight", "email"] };
      },
    ],
  ])(
    "a staged package whose %s differ from the continuity entry is refused, even with a matching digest",
    async (_what, field, edit) => {
      const id = await preparedRowId();
      reshapeStagedManifest(id, edit);
      const out = await acceptAsRenderer(engineWith(), { id });
      expectRefusedBeforeThePrompt(out, new RegExp(`\\(${field.replace(".", "\\.")} differs\\)`));
    },
  );

  test("with no baked built-in registry, accept is refused and nothing changes", async () => {
    const id = await preparedRowId();
    const out = await acceptAsRenderer(engineWith({ builtin: null }), { id });
    expectRefusedBeforeThePrompt(out, /^ERR_EXTENSION_MIGRATION_NO_REGISTRY:/);
    expect(getMigration(db, id)?.state).toBe("awaiting_approval");
  });

  test("a registry other than the baked root is refused", async () => {
    const id = await preparedRowId();
    const other = { url: "https://evil.example/", rootKey: built64(9) };
    const out = await acceptAsRenderer(engineWith({ builtin: other }), { id });
    expectRefusedBeforeThePrompt(out, /\(sourceRootFingerprint differs\)/);
  });

  test("a staged package signed for another publisher is refused", async () => {
    const id = await preparedRowId();
    reshapeStagedManifest(id, (m) => {
      m["publisher"] = { id: "nimbus", key: built64(7) };
    });
    const out = await acceptAsRenderer(engineWith(), { id });
    expectRefusedBeforeThePrompt(out, /\(publisherKey differs\)/);
  });

  test("an extension id that is already installed is refused, and the install is left alone", async () => {
    const other = { ...entry, legacyServiceId: "fixture_other" };
    const both = engineWith({ continuityTable: [entry, other] });
    await both.evaluate();
    const rows = listMigrations(db);
    const first = rows.find((r) => r.legacyServiceId === LEGACY)?.id ?? "";
    const second = rows.find((r) => r.legacyServiceId === "fixture_other")?.id ?? "";
    expect((await acceptAsRenderer(both, { id: first })).value?.["state"]).toBe("approved");
    const out = await acceptAsRenderer(both, { id: second });
    expect(out.error?.message).toMatch(/already installed/);
    expect(out.asked).toEqual([]);
    expect(listExtensions(db).map((r) => r.id)).toEqual([EXT]);
    expect(getMigration(db, first)?.state).toBe("approved");
  });

  /**
   * The extension installed and approved (through a first accept), and its row put back to
   * `awaiting_approval` — as if the owner had installed and approved it before answering.
   */
  async function installedThenPending(): Promise<string> {
    const e = engineWith();
    const id = await preparedRowId(e);
    expect((await acceptAsRenderer(e, { id })).value?.["state"]).toBe("approved");
    db.run("UPDATE connector_migration SET state = 'awaiting_approval' WHERE id = ?", [id]);
    return id;
  }

  test("an installed extension bound to the entry with a current legacy grant: approved, no prompt, nothing installed or granted", async () => {
    const id = await installedThenPending();
    const extBefore = JSON.stringify(listExtensions(db));
    const grantBefore = JSON.stringify(getRunGrant(db, EXT));
    const out = await acceptAsRenderer(engineWith(), { id });
    expect(out.error).toBeUndefined();
    expect(out.value?.["state"]).toBe("approved");
    expect(out.asked).toEqual([]);
    expect(JSON.stringify(listExtensions(db))).toBe(extBefore);
    expect(JSON.stringify(getRunGrant(db, EXT))).toBe(grantBefore);
  });

  test("an installed extension whose grant names an older tree digest is refused before the prompt", async () => {
    const id = await installedThenPending();
    const { upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    const grant = getRunGrant(db, EXT);
    if (grant === null) throw new Error("premise: a run grant");
    upsertRunGrant(db, { ...grant, tree_digest: "0".repeat(64) });
    const grantBefore = JSON.stringify(getRunGrant(db, EXT));
    const out = await acceptAsRenderer(engineWith(), { id });
    expect(out.error?.message).toMatch(
      /^ERR_EXTENSION_MIGRATION_FAILED: .*nimbus extension approve/,
    );
    expect(out.asked).toEqual([]);
    expect(JSON.stringify(getRunGrant(db, EXT))).toBe(grantBefore);
    expect(getMigration(db, id)?.state).toBe("failed");
  });

  /** A well-formed base64 Ed25519-sized key that is neither the fixture's root nor its publisher. */
  function built64(fill: number): string {
    return Buffer.from(new Uint8Array(32).fill(fill)).toString("base64");
  }
});

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { AutoUpdateCache } from "../extensions/auto-update-cache.ts";
import {
  _resetAutoUpdateMutexForTests,
  type AutoUpdateRpcDeps,
} from "../extensions/auto-update-rpc.ts";
import type { AvailableUpdate } from "../extensions/auto-update-types.ts";
import {
  PRE_T2_DISABLE_REASON,
  preT2DisabledRegistry,
  preT2DisableMessage,
} from "../extensions/hard-disable.ts";
import { readPublisherKey, writePublisherKey } from "../extensions/publisher-keys.ts";
import type { PublisherKeyFetcher } from "../extensions/registry-client.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../extensions/verify-signature.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

/**
 * `automation-rpc.ts` paths `automation-rpc.test.ts` does not reach: a REAL extension install
 * through the RPC (unsigned, and signed with an explicit publisher key), the `extension.update`
 * outcomes the `extension.stateChanged` event must carry, the pre-T2 and `_prev/` decorations of
 * `extension.list`/`info`, the sync fetcher/dry-run defaults, and the numeric-param refusals.
 */

const openDbs: Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  setGatewayEventBroadcast(undefined);
  preT2DisabledRegistry.reset();
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type StateChanged = {
  extensionId: string;
  action: string;
  ok: boolean;
  error?: string;
};

/** Captures every `extension.stateChanged` payload broadcast while the test runs. */
function captureStateChanges(): StateChanged[] {
  const seen: StateChanged[] = [];
  setGatewayEventBroadcast((method, params) => {
    const p = params as { kind?: string; payload?: StateChanged };
    if (method === "gateway.event" && p.kind === "extension.stateChanged" && p.payload) {
      seen.push(p.payload);
    }
  });
  return seen;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
}

describe("numeric params", () => {
  test("a non-finite or non-number limit is refused by name", async () => {
    const db = indexDb();
    for (const limit of ["10", Number.NaN, Number.POSITIVE_INFINITY]) {
      const history = await rejectionOf(
        dispatchAutomationRpc({
          method: "watcher.listHistory",
          params: { watcherId: "w1", limit },
          db,
        }),
      );
      expect(history).toBeInstanceOf(AutomationRpcError);
      expect((history as AutomationRpcError).message).toBe("Missing or invalid limit");
      expect((history as AutomationRpcError).rpcCode).toBe(-32602);

      const runs = await rejectionOf(
        dispatchAutomationRpc({
          method: "workflow.listRuns",
          params: { workflowName: "wf", limit },
          db,
        }),
      );
      expect((runs as AutomationRpcError).message).toBe("Missing or invalid limit");
    }
  });

  test("validateCondition checks sinceMs only after the predicate string is present", async () => {
    const out = await rejectionOf(
      dispatchAutomationRpc({
        method: "watcher.validateCondition",
        params: { graphPredicateJson: "{}", sinceMs: "yesterday" },
        db: indexDb(),
      }),
    );
    expect((out as AutomationRpcError).message).toBe("Missing or invalid sinceMs");
  });
});

describe("watcher.create — what counts as declaring filter.affectedService", () => {
  test("an ARRAY-shaped conditionJson declares nothing, so an unsupported kind still accepts it", async () => {
    // `alert_fired` rejects a real `filter.affectedService` (its watchers could never fire), but a
    // JSON array is not a condition object — it carries no `filter` the engine would read.
    const db = indexDb();
    const out = await dispatchAutomationRpc({
      method: "watcher.create",
      params: {
        name: "array",
        conditionType: "alert_fired",
        conditionJson: JSON.stringify([{ filter: { affectedService: "billing" } }]),
        actionType: "notify",
        actionJson: "{}",
      },
      db,
    });
    expect(out.kind).toBe("hit");
    const id = (out as { value: { id: string } }).value.id;
    const row = db.query("SELECT condition_json FROM watcher WHERE id = ?").get(id) as {
      condition_json: string;
    };
    expect(row.condition_json).toBe('[{"filter":{"affectedService":"billing"}}]');
  });
});

describe("extension.install through the RPC", () => {
  function unsignedSource(root: string, id: string, version: string): string {
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id, version, entry: "dist/index.js" }),
      "utf8",
    );
    writeFileSync(join(src, "dist", "index.js"), "export {}\n", "utf8");
    return src;
  }

  async function signedSource(root: string, keypair: { pubkey: Uint8Array; privkey: Uint8Array }) {
    const src = join(root, "signed-src");
    mkdirSync(join(src, "dist"), { recursive: true });
    const manifest = {
      id: "test.ext.signed",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(keypair.pubkey) },
    };
    const signature = await signManifest(manifest, keypair.privkey);
    writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify({ ...manifest, signature }));
    writeFileSync(join(src, "dist", "index.js"), "export default {};");
    return src;
  }

  const NOT_FOUND: PublisherKeyFetcher = { fetch: async () => ({ kind: "not_found" }) };

  test("an unsigned extension installs, and the event names the INSTALLED id, not the source path", async () => {
    const root = tempDir("nimbus-auto-install-");
    const src = unsignedSource(root, "test.ext.rpc", "1.2.3");
    const extensionsDir = join(root, "extensions");
    const db = indexDb();
    const events = captureStateChanges();

    const out = await dispatchAutomationRpc({
      method: "extension.install",
      params: { sourcePath: src },
      db,
      extensionsDir,
    });
    expect(out.kind).toBe("hit");
    const value = (out as { value: Record<string, unknown> }).value;
    expect(value["id"]).toBe("test.ext.rpc");
    expect(value["version"]).toBe("1.2.3");
    expect(value["installPath"]).toBe(join(extensionsDir, "test.ext.rpc"));
    expect(value["manifestHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(value["entryHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(listExtensions(db).map((r) => r.id)).toEqual(["test.ext.rpc"]);
    expect(events).toEqual([{ extensionId: "test.ext.rpc", action: "install", ok: true }]);
  });

  test("a signed extension verifies against an explicit key path, trimmed, and the key lands in the vault", async () => {
    const root = tempDir("nimbus-auto-signed-");
    const keypair = generateEd25519Keypair();
    const src = await signedSource(root, keypair);
    const keyFile = join(root, "publisher.key");
    writeFileSync(keyFile, `${encodeBase64(keypair.pubkey)}\n`);
    const vault = new MockVault();

    const out = await dispatchAutomationRpc({
      method: "extension.install",
      // Padded on purpose: read untrimmed, the path names no file and the install fails.
      params: { sourcePath: src, publisherKeyPath: `  ${keyFile}  ` },
      db: indexDb(),
      extensionsDir: join(root, "extensions"),
      vault,
      // The registry knows nothing of this publisher, so only the explicit key can verify it.
      fetcher: NOT_FOUND,
      enforceAirGap: false,
    });
    expect((out as { value: { id: string } }).value.id).toBe("test.ext.signed");
    const stored = await readPublisherKey(vault, "test-pub");
    expect(stored === undefined ? undefined : encodeBase64(stored)).toBe(
      encodeBase64(keypair.pubkey),
    );
  });

  test("a BLANK key path is not passed on: resolution falls to the registry, which refuses", async () => {
    const root = tempDir("nimbus-auto-blankkey-");
    const src = await signedSource(root, generateEd25519Keypair());
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src, publisherKeyPath: "   " },
        db: indexDb(),
        extensionsDir: join(root, "extensions"),
        vault: new MockVault(),
        fetcher: NOT_FOUND,
      }),
    );
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as AutomationRpcError).rpcCode).toBe(-32602);
    expect((err as AutomationRpcError).message).toBe(
      'publisher "test-pub" is not registered with the registry; install refused',
    );
    expect(events).toEqual([
      {
        extensionId: src,
        action: "install",
        ok: false,
        error: 'publisher "test-pub" is not registered with the registry; install refused',
      },
    ]);
  });

  test("a fetcher that rejects with a NON-Error is still a -32602 carrying its text", async () => {
    // The fetcher is an injected registry client; its rejection reaches the wire as a message
    // either way, never as a bare value the JSON-RPC layer cannot render.
    const root = tempDir("nimbus-auto-rejectfetch-");
    const src = await signedSource(root, generateEd25519Keypair());
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db: indexDb(),
        extensionsDir: join(root, "extensions"),
        vault: new MockVault(),
        fetcher: { fetch: () => Promise.reject("registry socket closed") },
      }),
    );
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as AutomationRpcError).rpcCode).toBe(-32602);
    expect((err as AutomationRpcError).message).toBe("registry socket closed");
    expect(events.map((e) => e.error)).toEqual(["registry socket closed"]);
  });

  test("enforceAirGap reaches the install: an uncached publisher key is refused before any fetch", async () => {
    const root = tempDir("nimbus-auto-airgap-");
    const src = await signedSource(root, generateEd25519Keypair());
    let fetched = 0;
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db: indexDb(),
        extensionsDir: join(root, "extensions"),
        vault: new MockVault(),
        fetcher: {
          fetch: async () => {
            fetched++;
            return { kind: "not_found" };
          },
        },
        enforceAirGap: true,
      }),
    );
    expect((err as AutomationRpcError).message).toStartWith(
      'air-gap is enforced; publisher key for "test-pub" is not in your local cache',
    );
    expect(fetched).toBe(0);
  });
});

describe("extension.update — the stateChanged event mirrors the outcome", () => {
  beforeEach(() => _resetAutoUpdateMutexForTests());

  function availableUpdate(id: string): AvailableUpdate {
    return {
      id,
      displayName: id,
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "",
      publisherStatus: "verified",
      manifestHash: "abcdef0123456789abcdef0123456789",
      signatureB64: "",
      entryHash: "",
      tarballUrl: "https://registry.invalid/x.tgz",
      permissionDiff: {
        network: { added: [], removed: [] },
        filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
      },
      verificationStatus: "verified",
      detectedAt: 0,
    };
  }

  function deps(overrides: Partial<AutoUpdateRpcDeps> = {}): {
    deps: AutoUpdateRpcDeps;
    upgraded: string[];
  } {
    const upgraded: string[] = [];
    const cache = new AutoUpdateCache();
    cache.upsert(availableUpdate("com.example.upd"));
    return {
      upgraded,
      deps: {
        cache,
        forcePoll: async () => {},
        gate: async () => "proceed",
        performUpgrade: async (c) => {
          upgraded.push(`${c.id}@${c.toVersion}`);
        },
        performDowngrade: async () => {},
        appendAudit: async () => {},
        getInstalledVersion: async () => "1.0.0",
        hasPrevVersion: async () => false,
        ...overrides,
      },
    };
  }

  test("an applied update reports ok:true and carries no error", async () => {
    const events = captureStateChanges();
    const { deps: autoUpdate, upgraded } = deps();
    const out = await dispatchAutomationRpc({
      method: "extension.update",
      params: { id: "com.example.upd", toVersion: "1.1.0" },
      db: indexDb(),
      autoUpdate,
    });
    expect(out).toEqual({ kind: "hit", value: { applied: true, jobId: "abcdef0123456789" } });
    expect(upgraded).toEqual(["com.example.upd@1.1.0"]);
    expect(events).toEqual([{ extensionId: "com.example.upd", action: "update", ok: true }]);
  });

  test("with no id at all the event still fires, naming the empty id and the cache miss", async () => {
    const events = captureStateChanges();
    const out = await dispatchAutomationRpc({
      method: "extension.update",
      params: {},
      db: indexDb(),
      autoUpdate: deps().deps,
    });
    expect(out).toEqual({ kind: "hit", value: { applied: false, reason: "cache_miss" } });
    expect(events).toEqual([{ extensionId: "", action: "update", ok: false, error: "cache_miss" }]);
  });

  test("a THROWN failure is reported and rethrown — including one that is not an Error", async () => {
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.update",
        params: { id: "com.example.upd", toVersion: "1.1.0" },
        db: indexDb(),
        autoUpdate: deps({ gate: () => Promise.reject("consent broker offline") }).deps,
      }),
    );
    expect(err).toBe("consent broker offline");
    expect(events).toEqual([
      {
        extensionId: "com.example.upd",
        action: "update",
        ok: false,
        error: "consent broker offline",
      },
    ]);
  });

  test("an unwired auto-update is a thrown -32603 the event reports by its message", async () => {
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.update",
        params: { id: "com.example.upd" },
        db: indexDb(),
      }),
    );
    expect((err as AutomationRpcError).rpcCode).toBe(-32603);
    expect(events).toEqual([
      {
        extensionId: "com.example.upd",
        action: "update",
        ok: false,
        error: "Gateway is not configured with auto-update support",
      },
    ]);
  });

  test("checkForUpdates with no params object lists the cache", async () => {
    const out = await dispatchAutomationRpc({
      method: "extension.checkForUpdates",
      params: null,
      db: indexDb(),
      autoUpdate: deps().deps,
    });
    expect(out.kind).toBe("hit");
    expect((out as { value: AvailableUpdate[] }).value.map((u) => u.id)).toEqual([
      "com.example.upd",
    ]);
  });
});

describe("extension.list / extension.info — pre-T2 and _prev decorations", () => {
  function seedRow(db: Database, id: string, installPath: string): void {
    insertExtensionRow(db, {
      id,
      version: "2.0.0",
      install_path: installPath,
      manifest_hash: "m".repeat(64),
      entry_hash: "e".repeat(64),
      enabled: 0,
      installed_at: 1,
      last_verified_at: 1,
    });
  }

  test("a pre-T2 row is flagged needs_reinstall, and only it survives the needs-reinstall filter", async () => {
    const db = indexDb();
    // Install paths under a fresh temp dir: a `_prev/` probe beside them can only ever see this
    // test's own (empty) directory, never one the shared OS temp root happens to hold.
    const root = tempDir("nimbus-pret2-list-");
    seedRow(db, "com.example.legacy", join(root, "legacy", "active"));
    seedRow(db, "com.example.modern", join(root, "modern", "active"));
    preT2DisabledRegistry.mark("com.example.legacy");

    const all = await dispatchAutomationRpc({ method: "extension.list", params: {}, db });
    const rows = (all as { value: { extensions: Array<Record<string, unknown>> } }).value
      .extensions;
    const byId = new Map(rows.map((r) => [r["id"], r]));
    expect(byId.get("com.example.legacy")?.["disabled_reason"]).toBe(PRE_T2_DISABLE_REASON);
    expect(byId.get("com.example.legacy")?.["needs_reinstall"]).toBe(true);
    expect(byId.get("com.example.modern")).not.toHaveProperty("disabled_reason");
    expect(byId.get("com.example.modern")).not.toHaveProperty("needs_reinstall");

    const filtered = await dispatchAutomationRpc({
      method: "extension.list",
      params: { filter: "needs-reinstall" },
      db,
    });
    expect(
      (filtered as { value: { extensions: Array<{ id: string }> } }).value.extensions.map(
        (e) => e.id,
      ),
    ).toEqual(["com.example.legacy"]);
  });

  test("extension.info on a pre-T2 row returns the reinstall message and its deps", async () => {
    const db = indexDb();
    seedRow(db, "com.example.legacy", join(tempDir("nimbus-pret2-info-"), "legacy", "active"));
    preT2DisabledRegistry.mark("com.example.legacy");
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.legacy" },
      db,
    });
    const value = (out as { value: { extension: Record<string, unknown>; message: string } }).value;
    expect(value.message).toBe(preT2DisableMessage("com.example.legacy", "2.0.0"));
    expect(value.extension["disabled_reason"]).toBe(PRE_T2_DISABLE_REASON);
    expect(value.extension["needs_reinstall"]).toBe(true);
    expect(value.extension["forwardDeps"]).toEqual([]);
    expect(value.extension["reverseDeps"]).toEqual([]);
  });

  /** `<extRoot>/active` is the install path; `<extRoot>/_prev/<version>` holds the rollback copy. */
  function extRootWithPrev(prev: "two" | "prerelease" | "empty" | "file"): string {
    const extRoot = join(tempDir("nimbus-ext-root-"), "com.example.a");
    mkdirSync(join(extRoot, "active"), { recursive: true });
    if (prev === "two") {
      // The upgrade swap keeps ONE version here; two survive only an interrupted swap. Two
      // entries are what make "the first one" and "the last one" give different answers.
      mkdirSync(join(extRoot, "_prev", "1.4.0"), { recursive: true });
      mkdirSync(join(extRoot, "_prev", "1.3.0"), { recursive: true });
    }
    if (prev === "prerelease") {
      // Two names whose CODE-UNIT order ("R" 0x52 < "b" 0x62) is the reverse of a case-folding
      // directory listing's: NTFS hands these back as [beta, RC1], so a probe that stopped
      // sorting would answer "1.4.0-RC1" there. ("two" above cannot show that — NTFS already
      // lists 1.3.0 before 1.4.0, so a missing sort passes it on Windows.)
      mkdirSync(join(extRoot, "_prev", "1.4.0-RC1"), { recursive: true });
      mkdirSync(join(extRoot, "_prev", "1.4.0-beta"), { recursive: true });
    }
    if (prev === "empty") mkdirSync(join(extRoot, "_prev"), { recursive: true });
    if (prev === "file") writeFileSync(join(extRoot, "_prev"), "not a directory");
    return extRoot;
  }

  async function infoPrevVersion(extRoot: string): Promise<unknown> {
    const db = indexDb();
    seedRow(db, "com.example.a", join(extRoot, "active"));
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.a" },
      db,
    });
    return (out as { value: { extension: Record<string, unknown> } }).value.extension[
      "prevVersion"
    ];
  }

  test("prevVersion is the version kept under _prev/ — the last in sorted order if several", async () => {
    expect(await infoPrevVersion(extRootWithPrev("two"))).toBe("1.4.0");
  });

  test("the order is the probe's own code-unit sort, never the filesystem's listing order", async () => {
    // Code-unit order also agrees with semver precedence here: prerelease identifiers compare in
    // ASCII order, so "beta" outranks "RC1".
    expect(await infoPrevVersion(extRootWithPrev("prerelease"))).toBe("1.4.0-beta");
  });

  test("an empty _prev/ means no previous version", async () => {
    expect(await infoPrevVersion(extRootWithPrev("empty"))).toBeNull();
  });

  test("an unreadable _prev/ (a file, not a directory) still returns the row, with no version", async () => {
    expect(await infoPrevVersion(extRootWithPrev("file"))).toBeNull();
  });
});

describe("extension.sync — prerequisites and defaults", () => {
  test("a vault without a key fetcher is a -32603 naming the fetcher", async () => {
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.sync",
        params: {},
        db: indexDb(),
        vault: new MockVault(),
      }),
    );
    expect((err as AutomationRpcError).rpcCode).toBe(-32603);
    expect((err as AutomationRpcError).message).toBe(
      "Gateway is not configured with a publisher key fetcher",
    );
  });

  /** One installed extension signed by `test-pub`, whose key is already cached in `vault`. */
  async function stageSignedRow(db: Database, vault: MockVault): Promise<void> {
    const keypair = generateEd25519Keypair();
    await writePublisherKey(vault, "test-pub", keypair.pubkey);
    const extDir = join(tempDir("nimbus-sync-ext-"), "ext-test-pub");
    mkdirSync(join(extDir, "dist"), { recursive: true });
    const manifest = {
      id: "ext-test-pub",
      version: "1.0.0",
      permissions: {},
      publisher: { id: "test-pub", key: encodeBase64(keypair.pubkey) },
    };
    const signature = await signManifest(manifest, keypair.privkey);
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({ ...manifest, signature }),
    );
    writeFileSync(join(extDir, "dist", "index.js"), "export default {};");
    insertExtensionRow(db, {
      id: "ext-test-pub",
      version: "1.0.0",
      install_path: extDir,
      manifest_hash: "m".repeat(64),
      entry_hash: "e".repeat(64),
      enabled: 1,
      installed_at: 1,
      last_verified_at: 1,
    });
  }

  test("a fetcher rejecting with a NON-Error is a -32603 carrying its text", async () => {
    const db = indexDb();
    const vault = new MockVault();
    await stageSignedRow(db, vault);
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.sync",
        params: {},
        db,
        vault,
        fetcher: { fetch: () => Promise.reject("registry socket closed") },
      }),
    );
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as AutomationRpcError).rpcCode).toBe(-32603);
    expect((err as AutomationRpcError).message).toBe("registry socket closed");
  });

  test("a non-boolean dryRun is NOT a dry run, and an absent enforceAirGap does not enforce", async () => {
    // A publisher the registry no longer knows is EVICTED from the vault on a real run and only
    // reported on a dry one — so the vault's state says which kind of run this was.
    const db = indexDb();
    const vault = new MockVault();
    await stageSignedRow(db, vault);

    const out = await dispatchAutomationRpc({
      method: "extension.sync",
      params: { dryRun: "yes" },
      db,
      vault,
      fetcher: { fetch: async () => ({ kind: "not_found" }) },
    });
    expect(out.kind).toBe("hit");
    expect((out as { value: { publishersEvicted: string[] } }).value.publishersEvicted).toEqual([
      "test-pub",
    ]);
    expect(await readPublisherKey(vault, "test-pub")).toBeUndefined();
  });
});

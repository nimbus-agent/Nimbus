import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { planNothing } from "../../test/helpers/empty-update-plan.ts";
import { insertExtensionRow, listExtensions } from "../automation/extension-store.ts";
import { dbRun } from "../db/write.ts";
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
  recoveredPendingRehashRegistry,
} from "../extensions/hard-disable.ts";
import { readPublisherKey } from "../extensions/publisher-keys.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../extensions/verify-signature.ts";
import { prevVersionsDir } from "../extensions/version-store.ts";
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
  /** A Vault whose every read rejects with a bare (non-Error) value. */
  function rejectingVault(reason: string): MockVault {
    const vault = new MockVault();
    vault.get = () => Promise.reject(reason);
    return vault;
  }
  const BLANK_KEY_REFUSAL =
    'extension is signed by publisher "test-pub" and no key for it is cached in the Vault; re-run with `--publisher-key <path>` naming that publisher\'s public key file';

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

  /** Stands in for the executor gate the server dispatcher builds; approves everything. */
  const approveAll = async (): Promise<boolean> => true;

  test("an unsigned extension installs, and the event names the INSTALLED id, not the source path", async () => {
    const root = tempDir("nimbus-auto-install-");
    const src = unsignedSource(root, "test.ext.rpc", "1.2.3");
    const extensionsDir = join(root, "extensions");
    const db = indexDb();
    const events = captureStateChanges();

    const out = await dispatchAutomationRpc({
      method: "extension.install",
      ownerGate: approveAll,
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
      ownerGate: approveAll,
      // Padded on purpose: read untrimmed, the path names no file and the install fails.
      params: { sourcePath: src, publisherKeyPath: `  ${keyFile}  ` },
      db: indexDb(),
      extensionsDir: join(root, "extensions"),
      vault,
    });
    expect((out as { value: { id: string } }).value.id).toBe("test.ext.signed");
    const stored = await readPublisherKey(vault, "test-pub");
    expect(stored === undefined ? undefined : encodeBase64(stored)).toBe(
      encodeBase64(keypair.pubkey),
    );
  });

  test("a BLANK key path is not passed on: with no Vault key the install refuses naming --publisher-key", async () => {
    const root = tempDir("nimbus-auto-blankkey-");
    const src = await signedSource(root, generateEd25519Keypair());
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        ownerGate: approveAll,
        params: { sourcePath: src, publisherKeyPath: "   " },
        db: indexDb(),
        extensionsDir: join(root, "extensions"),
        vault: new MockVault(),
      }),
    );
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as AutomationRpcError).rpcCode).toBe(-32602);
    expect((err as AutomationRpcError).message).toBe(BLANK_KEY_REFUSAL);
    expect(events).toEqual([
      {
        extensionId: src,
        action: "install",
        ok: false,
        error: BLANK_KEY_REFUSAL,
      },
    ]);
  });

  test("a Vault read that rejects with a NON-Error is still a -32602 carrying its text", async () => {
    // The rejection reaches the wire as a message either way, never as a bare value the JSON-RPC
    // layer cannot render.
    const root = tempDir("nimbus-auto-rejectfetch-");
    const src = await signedSource(root, generateEd25519Keypair());
    const events = captureStateChanges();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        ownerGate: approveAll,
        params: { sourcePath: src },
        db: indexDb(),
        extensionsDir: join(root, "extensions"),
        vault: rejectingVault("vault socket closed"),
      }),
    );
    expect(err).toBeInstanceOf(AutomationRpcError);
    expect((err as AutomationRpcError).rpcCode).toBe(-32602);
    expect((err as AutomationRpcError).message).toBe("vault socket closed");
    expect(events.map((e) => e.error)).toEqual(["vault socket closed"]);
  });

  test("REFUSES without the owner gate, and writes nothing (Non-Negotiable 2)", async () => {
    const root = tempDir("nimbus-auto-nogate-");
    const src = unsignedSource(root, "test.ext.nogate", "1.0.0");
    const extensionsDir = join(root, "extensions");
    const db = indexDb();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        params: { sourcePath: src },
        db,
        extensionsDir,
      }),
    );
    expect((err as AutomationRpcError).rpcCode).toBe(-32603);
    expect((err as AutomationRpcError).message).toContain("HITL gate");
    expect(listExtensions(db)).toEqual([]);
    expect(existsSync(join(extensionsDir, "test.ext.nogate"))).toBe(false);
  });

  test("a DENIED gate installs nothing: no row, no directory", async () => {
    const root = tempDir("nimbus-auto-deny-");
    const src = unsignedSource(root, "test.ext.denied", "1.0.0");
    const extensionsDir = join(root, "extensions");
    const db = indexDb();
    const err = await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        ownerGate: async () => false,
        params: { sourcePath: src },
        db,
        extensionsDir,
      }),
    );
    expect((err as AutomationRpcError).message).toStartWith("ERR_EXTENSION_INSTALL_NOT_APPROVED");
    expect(listExtensions(db)).toEqual([]);
    expect(existsSync(join(extensionsDir, "test.ext.denied"))).toBe(false);
  });

  test("the gate is asked as extension.install, over the RESOLVED plan, before the copy", async () => {
    const root = tempDir("nimbus-auto-payload-");
    const keypair = generateEd25519Keypair();
    const src = await signedSource(root, keypair);
    const extensionsDir = join(root, "extensions");
    const seen: Array<{ type: string; payload: Record<string, unknown>; copied: boolean }> = [];
    // The signed source fails I16 later (no key is cached), which is fine: this test is about
    // what the owner was asked, and that the question came before anything reached the disk.
    await rejectionOf(
      dispatchAutomationRpc({
        method: "extension.install",
        ownerGate: async (action) => {
          seen.push({
            ...action,
            copied: existsSync(join(extensionsDir, "test.ext.signed")),
          });
          return true;
        },
        params: { sourcePath: src },
        db: indexDb(),
        extensionsDir,
        vault: new MockVault(),
      }),
    );
    expect(seen).toHaveLength(1);
    const [asked] = seen;
    expect(asked?.type).toBe("extension.install");
    expect(asked?.copied).toBe(false);
    expect(asked?.payload).toEqual({
      id: "test.ext.signed",
      version: "1.0.0",
      sourcePath: src,
      // R6: no Nimbus verification is stored, so the prompt says so plainly.
      verifiedPublisher: null,
      publisherBadge: "Unverified publisher",
      publisher: {
        id: "test-pub",
        fingerprint: publisherKeyFingerprint(encodeBase64(keypair.pubkey)),
      },
      permissions: { network: [], filesystem: { read: [], write: [] } },
      installs: [{ id: "test.ext.signed", version: "1.0.0" }],
      // Set on every install the gateway has a Vault for; this manifest requires no connector.
      connectorRequirements: [],
    });
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
      packageSha256: "f".repeat(64),
      packageSizeBytes: 100,
      sourceRegistry: "main",
      rootFingerprint: "c".repeat(32),
      packagePath: "extensions/x/1.1.0/package.tgz",
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
        planUpdate: planNothing,
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

describe("extension.list / extension.info — pre-T2 and prev decorations", () => {
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

  /** The flat install is `<extensionsDir>/<id>`; `prevVersionsDir(extensionsDir, id)` holds the rollback copies. */
  function extensionsDirWithPrev(prev: "two" | "semver" | "prerelease" | "empty" | "file"): string {
    const extensionsDir = join(tempDir("nimbus-ext-root-"), "extensions");
    mkdirSync(join(extensionsDir, "com.example.a"), { recursive: true });
    const prevDir = prevVersionsDir(extensionsDir, "com.example.a");
    const mk = (v: string) => mkdirSync(join(prevDir, v), { recursive: true });
    if (prev === "two") {
      mk("1.4.0");
      mk("1.3.0");
    }
    if (prev === "semver") {
      // A code-unit sort picks 1.9.0; semver precedence picks 1.10.0.
      mk("1.9.0");
      mk("1.10.0");
    }
    if (prev === "prerelease") {
      // Prerelease identifiers compare in ASCII order, so "beta" outranks "RC1" whatever order
      // the filesystem lists them in.
      mk("1.4.0-RC1");
      mk("1.4.0-beta");
    }
    if (prev === "empty") mkdirSync(prevDir, { recursive: true });
    if (prev === "file") {
      mkdirSync(dirname(prevDir), { recursive: true });
      writeFileSync(prevDir, "not a directory");
    }
    return extensionsDir;
  }

  async function infoPrevVersion(extensionsDir: string): Promise<unknown> {
    const db = indexDb();
    seedRow(db, "com.example.a", join(extensionsDir, "com.example.a"));
    const out = await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "com.example.a" },
      db,
      extensionsDir,
    });
    return (out as { value: { extension: Record<string, unknown> } }).value.extension[
      "prevVersion"
    ];
  }

  test("prevVersion is the newest version kept under prev/ when several are present", async () => {
    expect(await infoPrevVersion(extensionsDirWithPrev("two"))).toBe("1.4.0");
  });

  test("the order is semver precedence (1.10.0 over 1.9.0), never the filesystem's listing order", async () => {
    expect(await infoPrevVersion(extensionsDirWithPrev("semver"))).toBe("1.10.0");
    expect(await infoPrevVersion(extensionsDirWithPrev("prerelease"))).toBe("1.4.0-beta");
  });

  test("an empty prev/ means no previous version", async () => {
    expect(await infoPrevVersion(extensionsDirWithPrev("empty"))).toBeNull();
  });

  test("an unreadable prev/ (a file, not a directory) still returns the row, with no version", async () => {
    expect(await infoPrevVersion(extensionsDirWithPrev("file"))).toBeNull();
  });
});

describe("extension.rehash — adopting on-disk bytes is gated like an install", () => {
  async function installed(): Promise<{ db: Database; installPath: string }> {
    const root = tempDir("nimbus-rehash-");
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(
      join(src, "nimbus.extension.json"),
      JSON.stringify({ id: "test.ext.rehash", version: "1.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(src, "dist", "index.js"), 'import "./chunk.js";\n');
    writeFileSync(join(src, "dist", "chunk.js"), "export {};\n");
    const db = indexDb();
    const extensionsDir = join(root, "extensions");
    await dispatchAutomationRpc({
      method: "extension.install",
      ownerGate: async () => true,
      params: { sourcePath: src },
      db,
      extensionsDir,
    });
    return { db, installPath: join(extensionsDir, "test.ext.rehash") };
  }

  const rehash = (db: Database, ownerGate?: (a: { type: string }) => Promise<boolean>) =>
    dispatchAutomationRpc({
      method: "extension.rehash",
      params: { id: "test.ext.rehash" },
      db,
      ...(ownerGate === undefined ? {} : { ownerGate }),
    });

  const digestOf = (db: Database): string | null | undefined =>
    listExtensions(db).find((r) => r.id === "test.ext.rehash")?.tree_digest;

  test("an unchanged tree reports changed:false and never prompts", async () => {
    const { db } = await installed();
    let asked = 0;
    const out = await rehash(db, async () => {
      asked++;
      return true;
    });
    expect((out as { value: { changed: boolean } }).value.changed).toBe(false);
    expect(asked).toBe(0);
  });

  test("a changed SIBLING file is adopted only on approval, asked as extension.install", async () => {
    const { db, installPath } = await installed();
    const before = digestOf(db);
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    const types: string[] = [];
    await rehash(db, async (a) => {
      types.push(a.type);
      return true;
    });
    expect(types).toEqual(["extension.install"]);
    expect(digestOf(db)).toBe(computeExtensionTreeDigest(installPath));
    expect(digestOf(db)).not.toBe(before);
  });

  test("approving a rehash re-enables a crash-recovered extension with the measured digest", async () => {
    const { db, installPath } = await installed();
    // The state crash recovery leaves: files promoted, digest NULL, extension disabled.
    dbRun(db, "UPDATE extension SET tree_digest = NULL, enabled = 0 WHERE id = ?", [
      "test.ext.rehash",
    ]);
    recoveredPendingRehashRegistry.mark("test.ext.rehash");
    try {
      const denied = await rejectionOf(rehash(db, async () => false));
      expect((denied as AutomationRpcError).message).toStartWith(
        "ERR_EXTENSION_REHASH_NOT_APPROVED",
      );
      expect(listExtensions(db)[0]?.enabled).toBe(0);

      await rehash(db, async () => true);

      const row = listExtensions(db).find((r) => r.id === "test.ext.rehash");
      expect(row?.tree_digest).toBe(computeExtensionTreeDigest(installPath));
      expect(row?.enabled).toBe(1);
      expect(recoveredPendingRehashRegistry.has("test.ext.rehash")).toBe(false);
    } finally {
      recoveredPendingRehashRegistry.reset();
    }
  });

  test("a DENIED rehash leaves the stored digest untouched", async () => {
    const { db, installPath } = await installed();
    const before = digestOf(db);
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 3;\n");
    const err = await rejectionOf(rehash(db, async () => false));
    expect((err as AutomationRpcError).message).toStartWith("ERR_EXTENSION_REHASH_NOT_APPROVED");
    expect(digestOf(db)).toBe(before);
  });

  test("a changed ENTRY is refused before any prompt — that is tampering, not a rehash", async () => {
    const { db, installPath } = await installed();
    writeFileSync(join(installPath, "dist", "index.js"), "steal();\n");
    let asked = 0;
    const err = await rejectionOf(
      rehash(db, async () => {
        asked++;
        return true;
      }),
    );
    expect((err as AutomationRpcError).message).toStartWith("ERR_EXTENSION_REHASH_MISMATCH");
    expect(asked).toBe(0);
  });

  test("bytes that change WHILE the owner is deciding are not adopted", async () => {
    const { db, installPath } = await installed();
    const before = digestOf(db);
    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 4;\n");
    const err = await rejectionOf(
      rehash(db, async () => {
        writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 5;\n");
        return true;
      }),
    );
    expect((err as AutomationRpcError).message).toStartWith("ERR_EXTENSION_REHASH_CHANGED");
    expect(digestOf(db)).toBe(before);
  });

  test("REFUSES without the owner gate", async () => {
    const { db } = await installed();
    const err = await rejectionOf(rehash(db));
    expect((err as AutomationRpcError).message).toContain("HITL gate");
  });
});

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../automation/extension-store.ts";
import {
  CONTINUITY_TABLE,
  type ContinuityEntry,
} from "../extensions/continuity/continuity-table.ts";
import { installExtensionFromLocalDirectory } from "../extensions/install-from-local.ts";
import { getRunGrant, upsertRunGrant } from "../extensions/run-grant-store.ts";
import {
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../extensions/verify-signature.ts";
import { LocalIndex } from "../index/local-index.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { MockVault } from "../vault/mock.ts";
import { createIpcServer } from "./server/index.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";

/**
 * PR 7 · C7: the gateway composition's continuity table reaches the three IPC paths that bind —
 * `extension.approveRun`, `extension.credentialSet`/`credentialStatus` and `connector.remove`'s
 * extension-backed refusal — over a REAL IPC connection. Each fixture entry differs from the baked
 * `CONTINUITY_TABLE` (a test publisher key and root fingerprint), so a path that falls back to the
 * baked default treats the extension as unbound while the rest of the gateway binds it.
 */

const SECRET = "fixture-token-value-do-not-leak";
const FIXTURE_FP = "fixture-root-fp";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Frame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

/** One connection: approves every `consent.request` and resolves with the response to `frame`. */
function call(listenPath: string, frame: Frame): Promise<Frame> {
  return new Promise((done, fail) => {
    const sock = net.createConnection(listenPath);
    let buf = "";
    const deadline = setTimeout(() => {
      sock.destroy();
      fail(new Error("TIMEOUT"));
    }, 10_000);
    const send = (f: Frame): void => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", ...f })}\n`);
    };
    sock.on("connect", () => send(frame));
    sock.on("data", (d) => {
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl)) as Frame;
        buf = buf.slice(nl + 1);
        if (msg.method === "consent.request") {
          send({
            id: `respond-${String(msg.params?.["requestId"])}`,
            method: "consent.respond",
            params: { requestId: msg.params?.["requestId"], approved: true },
          });
        } else if (msg.id === frame.id) {
          clearTimeout(deadline);
          sock.destroy();
          done(msg);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(deadline);
      fail(e);
    });
  });
}

interface Gateway {
  readonly listenPath: string;
  readonly db: Database;
  readonly vault: MockVault;
  readonly root: string;
  readonly extensionsDir: string;
}

/** A real IPC server; `continuityTable` absent means the production default. */
async function gateway(continuityTable: readonly ContinuityEntry[] | undefined): Promise<Gateway> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-composed-table-")));
  const dataDir = join(root, "data");
  const extensionsDir = join(dataDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  const db = openMemoryIndexDatabase();
  const vault = new MockVault();
  const listenPath =
    platform() === "win32"
      ? `\\\\.\\pipe\\nimbus-c7-${randomUUID()}`
      : join(tmpdir(), `nimbus-c7-${randomUUID()}.sock`);
  // Only what the three paths touch: the protected roots `approveRun` resolves grants against,
  // and the stop `credentialSet` makes after a write.
  const mesh = {
    userMcpProtectedRoots: () => [dataDir, join(root, "config")],
    stopExtensionClient: async () => {},
    isExtensionRunning: () => false,
    removeExtensionSandbox: async () => {},
  } as unknown as NonNullable<CreateIpcServerOptions["connectorMesh"]>;
  const server = createIpcServer({
    listenPath,
    vault,
    version: "c7-test",
    localIndex: new LocalIndex(db),
    dataDir,
    configDir: join(root, "config"),
    extensionsDir,
    extensionsRuntimeEnabled: true,
    connectorMesh: mesh,
    ...(continuityTable === undefined ? {} : { continuityTable }),
  });
  await server.start();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  cleanups.push(() => server.stop());
  return { listenPath, db, vault, root, extensionsDir };
}

/** Installs a signed `id` declaring a `token` credential; its row carries the fixture root fp. */
async function installSigned(g: Gateway, id: string): Promise<string> {
  const src = join(g.root, `src-${id}`);
  mkdirSync(join(src, "dist"), { recursive: true });
  const kp = generateEd25519Keypair();
  const publisherKey = encodeBase64(kp.pubkey);
  const manifest: Record<string, unknown> = {
    id,
    version: "1.0.0",
    entry: "dist/index.js",
    credentials: { token: { env: "FIXTURE_TOKEN" } },
    publisher: { id: "test-pub", key: publisherKey },
  };
  manifest["signature"] = await signManifest(manifest, kp.privkey);
  writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  const publisherKeyPath = join(g.root, `pub-${id}.key`);
  writeFileSync(publisherKeyPath, `${publisherKey}\n`);
  await installExtensionFromLocalDirectory({
    db: g.db,
    extensionsDir: g.extensionsDir,
    sourcePath: src,
    approve: async () => true,
    vault: new MockVault(),
    publisherKeyPath,
  });
  g.db.run("UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", [FIXTURE_FP, id]);
  return publisherKey;
}

/** The real Readwise binding with a TEST publisher key and root fingerprint (≠ the baked entry). */
function readwiseFixtureEntry(publisherKey: string): ContinuityEntry {
  const baked = CONTINUITY_TABLE.find((e) => e.legacyServiceId === "readwise");
  if (baked === undefined) throw new Error("premise: the baked table binds readwise");
  return { ...baked, publisherKey, sourceRootFingerprint: FIXTURE_FP };
}

function grantVaultKey(db: Database, id: string): string | undefined {
  const json = getRunGrant(db, id)?.credentials_json;
  if (json === undefined) return undefined;
  const parsed = JSON.parse(json) as Record<string, { vaultKey?: string }>;
  return parsed["token"]?.vaultKey;
}

describe("C7: the IPC paths bind through the composition's continuity table", () => {
  test("approveRun and credentialSet bind to the legacy key; connector.remove refuses", async () => {
    // The table is filled once the key is known; the server holds the SAME array.
    const table: ContinuityEntry[] = [];
    const g = await gateway(table);
    const key = await installSigned(g, "com.nimbus.readwise");
    const entry = readwiseFixtureEntry(key);
    table.push(entry);
    // Premise: the baked default does NOT bind this extension (its key is not the real one).
    expect(entry.publisherKey).not.toBe(CONTINUITY_TABLE[0]?.publisherKey);

    const approved = await call(g.listenPath, {
      id: "approve",
      method: "extension.approveRun",
      params: { id: "com.nimbus.readwise" },
    });
    expect(approved.error).toBeUndefined();
    expect(grantVaultKey(g.db, "com.nimbus.readwise")).toBe("readwise.token");

    const set = await call(g.listenPath, {
      id: "set",
      method: "extension.credentialSet",
      params: { id: "com.nimbus.readwise", name: "token", value: SECRET },
    });
    expect(set.error).toBeUndefined();
    expect(await g.vault.get("readwise.token")).toBe(SECRET);
    expect(await g.vault.get("ext.ext_com_nimbus_readwise.token")).toBeNull();

    const status = await call(g.listenPath, {
      id: "status",
      method: "extension.credentialStatus",
      params: { id: "com.nimbus.readwise" },
    });
    expect(status.error).toBeUndefined();
    expect(status.result).toEqual({ credentials: [{ name: "token", set: true }] });

    new LocalIndex(g.db).ensureConnectorSchedulerRegistration("readwise", 60_000, 1);
    const removed = await call(g.listenPath, {
      id: "remove",
      method: "connector.remove",
      params: { serviceId: "readwise" },
    });
    expect(removed.error?.message).toStartWith("ERR_CONNECTOR_IS_EXTENSION:");
    expect(removed.error?.message).toContain("nimbus extension remove com.nimbus.readwise");
  });

  test("credentialSet and credentialStatus trust a legacy key only the composition's table maps", async () => {
    const entry: ContinuityEntry = {
      legacyServiceId: "fixturewise",
      extensionId: "com.example.fixturewise",
      publisherKey: "k",
      sourceRootFingerprint: FIXTURE_FP,
      credentials: { token: "fixturewise.token" },
      expectedPermissions: { network: [], read: [], write: [] },
      itemTypes: ["highlight"],
    };
    const g = await gateway([entry]);
    insertExtensionRow(g.db, {
      id: entry.extensionId,
      version: "1.0.0",
      install_path: join(g.root, "nowhere"),
      manifest_hash: "h",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    upsertRunGrant(g.db, {
      extension_id: entry.extensionId,
      service_id: "ext_com_example_fixturewise",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: '{"token":{"env":"FIXTURE_TOKEN","vaultKey":"fixturewise.token"}}',
    });

    const set = await call(g.listenPath, {
      id: "set",
      method: "extension.credentialSet",
      params: { id: entry.extensionId, name: "token", value: SECRET },
    });
    expect(set.error).toBeUndefined();
    expect(await g.vault.get("fixturewise.token")).toBe(SECRET);
    const status = await call(g.listenPath, {
      id: "status",
      method: "extension.credentialStatus",
      params: { id: entry.extensionId },
    });
    expect(status.result).toEqual({ credentials: [{ name: "token", set: true }] });
  });

  test("connector.remove's extension-backed refusal is decided by the composition's table", async () => {
    const table: ContinuityEntry[] = [];
    const g = await gateway(table);
    const key = await installSigned(g, "com.nimbus.readwise");
    table.push(readwiseFixtureEntry(key));
    // A grant seeded directly, so this test depends on no other path's table.
    upsertRunGrant(g.db, {
      extension_id: "com.nimbus.readwise",
      service_id: "ext_com_nimbus_readwise",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: '{"token":{"env":"FIXTURE_TOKEN","vaultKey":"readwise.token"}}',
    });
    new LocalIndex(g.db).ensureConnectorSchedulerRegistration("readwise", 60_000, 1);
    const removed = await call(g.listenPath, {
      id: "remove",
      method: "connector.remove",
      params: { serviceId: "readwise" },
    });
    expect(removed.error?.message).toStartWith("ERR_CONNECTOR_IS_EXTENSION:");
  });

  test("with no composed table the server keeps the production default (fixture key unbound)", async () => {
    const g = await gateway(undefined);
    await installSigned(g, "com.nimbus.readwise");
    const approved = await call(g.listenPath, {
      id: "approve",
      method: "extension.approveRun",
      params: { id: "com.nimbus.readwise" },
    });
    expect(approved.error).toBeUndefined();
    expect(grantVaultKey(g.db, "com.nimbus.readwise")).toBe("ext.ext_com_nimbus_readwise.token");
    new LocalIndex(g.db).ensureConnectorSchedulerRegistration("readwise", 60_000, 1);
    const removed = await call(g.listenPath, {
      id: "remove",
      method: "connector.remove",
      params: { serviceId: "readwise" },
    });
    // Unbound, so `readwise` is not extension-backed: no ERR_CONNECTOR_IS_EXTENSION.
    expect(removed.error?.message ?? "").not.toContain("ERR_CONNECTOR_IS_EXTENSION");
  });
});

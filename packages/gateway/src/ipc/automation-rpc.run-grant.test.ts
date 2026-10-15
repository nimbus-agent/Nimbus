import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getExtensionRunGrant } from "../automation/extension-run-grant-store.ts";
import { setExtensionEnabled } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

/** `extension.approveRun` / `extension.revokeRun` (extension-runtime design § 4.4, PR 2). */

const openDbs: Database[] = [];
const tempDirs: string[] = [];
afterEach(() => {
  setGatewayEventBroadcast(undefined);
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function rejectionOf(p: Promise<unknown>): Promise<AutomationRpcError> {
  const e = await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (err: unknown) => err,
  );
  if (!(e instanceof AutomationRpcError)) throw e;
  return e;
}

type Action = { type: string; payload: Record<string, unknown> };
type Gate = (a: Action) => Promise<boolean>;

const ID = "com.example.Runner";

async function installed(
  permissions: unknown = { network: [], filesystem: { read: [], write: [] } },
): Promise<{
  db: Database;
  installPath: string;
  protectedDir: string;
}> {
  const root = tempDir("nimbus-run-grant-");
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  writeFileSync(
    join(src, "nimbus.extension.json"),
    JSON.stringify({ id: ID, version: "1.0.0", entry: "dist/index.js", permissions }),
  );
  writeFileSync(join(src, "dist", "index.js"), 'import "./chunk.js";\n');
  writeFileSync(join(src, "dist", "chunk.js"), "export {};\n");
  const protectedDir = join(root, "nimbus-data");
  mkdirSync(protectedDir);
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  const extensionsDir = join(root, "extensions");
  await dispatchAutomationRpc({
    method: "extension.install",
    ownerGate: async () => true,
    params: { sourcePath: src },
    db,
    extensionsDir,
  });
  return { db, installPath: join(extensionsDir, ID), protectedDir };
}

function approve(
  db: Database,
  opts: { gate?: Gate; protectedRoots?: string[]; modelAccess?: unknown; id?: string } = {},
) {
  return dispatchAutomationRpc({
    method: "extension.approveRun",
    params: {
      id: opts.id ?? ID,
      ...(opts.modelAccess !== undefined && { modelAccess: opts.modelAccess }),
    },
    db,
    ...(opts.gate !== undefined && { ownerGate: opts.gate }),
    ...(opts.protectedRoots !== undefined && {
      runGrant: { protectedRoots: opts.protectedRoots, platform: process.platform },
    }),
  });
}

function recordingGate(answer = true): { gate: Gate; asked: Action[] } {
  const asked: Action[] = [];
  return {
    asked,
    gate: async (a) => {
      asked.push(a);
      return answer;
    },
  };
}

describe("extension.approveRun", () => {
  test("asks as extension.run over the RESOLVED grant and stores exactly that", async () => {
    const root = tempDir("nimbus-run-grant-user-");
    mkdirSync(join(root, "docs"));
    mkdirSync(join(root, "out"));
    const { db, installPath, protectedDir } = await installed({
      network: ["API.example.com"],
      filesystem: { read: [join(root, "docs")], write: [join(root, "out")] },
    });
    const { gate, asked } = recordingGate();
    await approve(db, { gate, protectedRoots: [protectedDir], modelAccess: true });
    expect(asked).toHaveLength(1);
    const action = asked[0] as Action;
    expect(action.type).toBe("extension.run");
    const expectedPerms = {
      network: ["api.example.com"],
      filesystem: {
        read: [realpathSync.native(installPath), realpathSync.native(join(root, "docs"))],
        write: [realpathSync.native(join(root, "out"))],
      },
    };
    expect(action.payload).toMatchObject({
      id: ID,
      version: "1.0.0",
      serviceId: "ext_com_example_runner",
      permissions: expectedPerms,
      modelAccess: true,
      replaces: null,
    });
    const grant = getExtensionRunGrant(db, ID);
    expect(grant).toMatchObject({
      serviceId: "ext_com_example_runner",
      version: "1.0.0",
      treeDigest: action.payload["treeDigest"],
      permissions: expectedPerms,
      modelAccess: true,
    });
  });

  test("a DENIED approval writes nothing", async () => {
    const { db, protectedDir } = await installed();
    const err = await rejectionOf(
      approve(db, { gate: async () => false, protectedRoots: [protectedDir] }),
    );
    expect(err.message).toStartWith("ERR_EXTENSION_RUN_NOT_APPROVED");
    expect(getExtensionRunGrant(db, ID)).toBeNull();
  });

  test("REFUSES without the owner gate or without the protected directories", async () => {
    const { db, protectedDir } = await installed();
    expect((await rejectionOf(approve(db, { protectedRoots: [protectedDir] }))).message).toContain(
      "HITL gate",
    );
    expect((await rejectionOf(approve(db, { gate: async () => true }))).message).toContain(
      "protected directories",
    );
  });

  test("refuses a manifest path inside a protected directory, before any prompt", async () => {
    const root = tempDir("nimbus-run-grant-prot-");
    const { db } = await installed({
      network: [],
      filesystem: { read: [root], write: [] },
    });
    const { gate, asked } = recordingGate();
    const err = await rejectionOf(approve(db, { gate, protectedRoots: [root] }));
    expect(err.message).toStartWith("ERR_EXTENSION_GRANT_PROTECTED");
    expect(asked).toHaveLength(0);
  });

  test("refuses a disabled, unknown, unhashed or modified extension before any prompt", async () => {
    const { db, installPath, protectedDir } = await installed();
    const { gate, asked } = recordingGate();
    const opts = { gate, protectedRoots: [protectedDir] };

    expect((await rejectionOf(approve(db, { ...opts, id: "nope" }))).message).toBe(
      "Extension not found",
    );

    setExtensionEnabled(db, ID, false);
    expect((await rejectionOf(approve(db, opts))).message).toStartWith(
      "ERR_EXTENSION_RUN_DISABLED",
    );
    setExtensionEnabled(db, ID, true);

    writeFileSync(join(installPath, "dist", "chunk.js"), "steal();\n");
    expect((await rejectionOf(approve(db, opts))).message).toStartWith(
      "ERR_EXTENSION_RUN_MISMATCH",
    );
    writeFileSync(join(installPath, "dist", "index.js"), "steal();\n");
    expect((await rejectionOf(approve(db, opts))).message).toStartWith(
      "ERR_EXTENSION_RUN_MISMATCH",
    );

    db.run("UPDATE extension SET tree_digest = NULL WHERE id = ?", [ID]);
    expect((await rejectionOf(approve(db, opts))).message).toStartWith(
      "ERR_EXTENSION_RUN_UNHASHED",
    );
    expect(asked).toHaveLength(0);
  });

  test("bytes that change WHILE the owner is deciding are not granted", async () => {
    const { db, installPath, protectedDir } = await installed();
    const err = await rejectionOf(
      approve(db, {
        protectedRoots: [protectedDir],
        gate: async () => {
          writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 9;\n");
          return true;
        },
      }),
    );
    expect(err.message).toStartWith("ERR_EXTENSION_RUN_CHANGED");
    expect(getExtensionRunGrant(db, ID)).toBeNull();
  });

  test("re-approval keeps the service id and shows what it replaces", async () => {
    const { db, protectedDir } = await installed();
    await approve(db, { gate: async () => true, protectedRoots: [protectedDir] });
    db.run("UPDATE extension_run_grant SET service_id = 'ext_kept' WHERE extension_id = ?", [ID]);
    const { gate, asked } = recordingGate();
    await approve(db, { gate, protectedRoots: [protectedDir], modelAccess: true });
    expect((asked[0] as Action).payload["serviceId"]).toBe("ext_kept");
    expect((asked[0] as Action).payload["replaces"]).toMatchObject({ modelAccess: false });
    expect(getExtensionRunGrant(db, ID)?.serviceId).toBe("ext_kept");
    expect(getExtensionRunGrant(db, ID)?.modelAccess).toBe(true);
  });

  test("rejects a non-boolean modelAccess", async () => {
    const { db, protectedDir } = await installed();
    const err = await rejectionOf(
      approve(db, { gate: async () => true, protectedRoots: [protectedDir], modelAccess: "yes" }),
    );
    expect(err.message).toBe("modelAccess must be a boolean");
  });
});

describe("extension.revokeRun / remove / info", () => {
  test("revoke deletes the grant; a second revoke reports nothing revoked", async () => {
    const { db, protectedDir } = await installed();
    await approve(db, { gate: async () => true, protectedRoots: [protectedDir] });
    const revoke = () =>
      dispatchAutomationRpc({ method: "extension.revokeRun", params: { id: ID }, db });
    expect(await revoke()).toEqual({ kind: "hit", value: { id: ID, revoked: true } });
    expect(getExtensionRunGrant(db, ID)).toBeNull();
    expect(await revoke()).toEqual({ kind: "hit", value: { id: ID, revoked: false } });
  });

  test("extension.info carries the grant, and extension.remove takes it away", async () => {
    const { db, protectedDir } = await installed();
    const info = async () =>
      (
        (await dispatchAutomationRpc({ method: "extension.info", params: { id: ID }, db })) as {
          value: { extension: { runGrant: unknown } };
        }
      ).value.extension.runGrant;
    expect(await info()).toBeNull();
    await approve(db, { gate: async () => true, protectedRoots: [protectedDir] });
    expect(await info()).toMatchObject({ serviceId: "ext_com_example_runner" });
    await dispatchAutomationRpc({ method: "extension.remove", params: { id: ID }, db });
    expect(db.query("SELECT COUNT(*) AS n FROM extension_run_grant").get()).toEqual({ n: 0 });
  });
});

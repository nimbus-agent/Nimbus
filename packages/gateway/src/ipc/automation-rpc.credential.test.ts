import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { type AutomationOwnerGate, dispatchAutomationRpc } from "./automation-rpc.ts";

const EXT = "rpc.cred";
const KEY = "ext.ext_rpc_cred.token";
const SECRET = "s3cr3t-value-do-not-leak";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function approved(): Promise<{ db: Database; vault: MockVault }> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-rpc-cred-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  writeFileSync(
    join(src, "nimbus.extension.json"),
    JSON.stringify({
      id: EXT,
      version: "1.0.0",
      entry: "dist/index.js",
      credentials: { token: { env: "CRED_TOKEN" } },
    }),
  );
  writeFileSync(join(src, "dist", "index.js"), "export {};\n");
  const extensionsDir = join(root, "data", "extensions");
  await dispatchAutomationRpc({
    method: "extension.install",
    params: { sourcePath: src },
    db,
    extensionsDir,
    ownerGate: async () => true,
  });
  const env: ExtensionRunGrantEnv = {
    platform: process.platform,
    protectedRoots: [join(root, "data")],
    runtimeReadPaths: [],
    realpath: (p) => realpathSync.native(p),
  };
  await dispatchAutomationRpc({
    method: "extension.approveRun",
    params: { id: EXT },
    db,
    runGrantEnv: env,
    ownerGate: async () => true,
  });
  return { db, vault: new MockVault() };
}

function recordingGate(answer: boolean): {
  gate: AutomationOwnerGate;
  calls: Array<{ type: string; payload: Record<string, unknown> }>;
} {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    gate: async (a) => {
      calls.push(a);
      return answer;
    },
  };
}

async function rejection(p: Promise<unknown>): Promise<{ rpcCode?: number; message: string }> {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Error);
  return e as { rpcCode?: number; message: string };
}

describe("extension.credentialSet / credentialStatus over the automation dispatcher", () => {
  test("one owner prompt per set; the write lands at the grant's key; status reports it", async () => {
    const { db, vault } = await approved();
    const { gate, calls } = recordingGate(true);
    const before = await dispatchAutomationRpc({
      method: "extension.credentialStatus",
      params: { id: EXT },
      db,
      vault,
    });
    expect(before).toEqual({
      kind: "hit",
      value: { credentials: [{ name: "token", set: false }] },
    });
    const out = await dispatchAutomationRpc({
      method: "extension.credentialSet",
      params: { id: EXT, name: "token", value: SECRET },
      db,
      vault,
      ownerGate: gate,
    });
    expect(out).toEqual({ kind: "hit", value: { name: "token", set: true } });
    expect(calls).toEqual([{ type: "vault.set", payload: { extensionId: EXT, name: "token" } }]);
    expect(await vault.get(KEY)).toBe(SECRET);
    const text = JSON.stringify([out, calls]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(KEY);
    const after = await dispatchAutomationRpc({
      method: "extension.credentialStatus",
      params: { id: EXT },
      db,
      vault,
    });
    expect(after).toEqual({ kind: "hit", value: { credentials: [{ name: "token", set: true }] } });
  });

  test("denied consent writes nothing and is -32603", async () => {
    const { db, vault } = await approved();
    const e = await rejection(
      dispatchAutomationRpc({
        method: "extension.credentialSet",
        params: { id: EXT, name: "token", value: SECRET },
        db,
        vault,
        ownerGate: recordingGate(false).gate,
      }),
    );
    expect(e.rpcCode).toBe(-32603);
    expect(e.message).toMatch(/^ERR_EXTENSION_CREDENTIAL_NOT_APPROVED/);
    expect(await vault.get(KEY)).toBeNull();
  });

  test("an undeclared name is -32602 ERR_EXTENSION_CREDENTIAL_UNKNOWN, with no prompt", async () => {
    const { db, vault } = await approved();
    const { gate, calls } = recordingGate(true);
    const e = await rejection(
      dispatchAutomationRpc({
        method: "extension.credentialSet",
        params: { id: EXT, name: "other", value: SECRET },
        db,
        vault,
        ownerGate: gate,
      }),
    );
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toMatch(/^ERR_EXTENSION_CREDENTIAL_UNKNOWN/);
    expect(calls).toHaveLength(0);
  });

  test("a non-string value is invalid params and never echoed", async () => {
    const { db, vault } = await approved();
    const e = await rejection(
      dispatchAutomationRpc({
        method: "extension.credentialSet",
        params: { id: EXT, name: "token", value: 42 },
        db,
        vault,
        ownerGate: async () => true,
      }),
    );
    expect(e.rpcCode).toBe(-32602);
  });

  test("an unknown extension is -32602 'Extension not found' on both methods", async () => {
    const { db, vault } = await approved();
    for (const [method, params] of [
      ["extension.credentialSet", { id: "nope", name: "token", value: SECRET }],
      ["extension.credentialStatus", { id: "nope" }],
    ] as const) {
      const e = await rejection(
        dispatchAutomationRpc({ method, params, db, vault, ownerGate: async () => true }),
      );
      expect(e.rpcCode, method).toBe(-32602);
      expect(e.message, method).toBe("Extension not found");
    }
  });

  test("credentialSet refuses without the owner's gate", async () => {
    const { db, vault } = await approved();
    const e = await rejection(
      dispatchAutomationRpc({
        method: "extension.credentialSet",
        params: { id: EXT, name: "token", value: SECRET },
        db,
        vault,
      }),
    );
    expect(e.rpcCode).toBe(-32603);
    expect(await vault.get(KEY)).toBeNull();
  });
});

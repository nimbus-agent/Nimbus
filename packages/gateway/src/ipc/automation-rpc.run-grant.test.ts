import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setExtensionTreeDigest } from "../automation/extension-store.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAutomationRpc } from "./automation-rpc.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function installed(): Promise<{
  db: Database;
  installPath: string;
  env: ExtensionRunGrantEnv;
}> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-rpc-run-grant-")));
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => db.close());
  const src = join(root, "src");
  mkdirSync(join(src, "dist"), { recursive: true });
  writeFileSync(
    join(src, "nimbus.extension.json"),
    JSON.stringify({ id: "rpc.run", version: "1.0.0", entry: "dist/index.js" }),
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
  return {
    db,
    installPath: join(extensionsDir, "rpc.run"),
    env: {
      platform: process.platform,
      protectedRoots: [join(root, "data")],
      runtimeReadPaths: [],
      realpath: (p) => realpathSync.native(p),
    },
  };
}

type ListItem = { id: string; runState: string; runGrant: { serviceId: string } | null };

async function listed(db: Database): Promise<ListItem[]> {
  const out = (await dispatchAutomationRpc({ method: "extension.list", params: {}, db })) as {
    value: { extensions: ListItem[] };
  };
  return out.value.extensions;
}

describe("extension.approveRun / extension.revokeRun over the automation dispatcher", () => {
  test("refuses without the owner gate, and without the run-grant env", async () => {
    const { db, env } = await installed();
    await expect(
      dispatchAutomationRpc({
        method: "extension.approveRun",
        params: { id: "rpc.run" },
        db,
        runGrantEnv: env,
      }),
    ).rejects.toThrow(/requires the owner's HITL gate/);
    await expect(
      dispatchAutomationRpc({
        method: "extension.approveRun",
        params: { id: "rpc.run" },
        db,
        ownerGate: async () => true,
      }),
    ).rejects.toThrow(/not configured to resolve extension run grants/);
  });

  test("an unknown id is -32602 'Extension not found' on both methods", async () => {
    const { db, env } = await installed();
    for (const method of ["extension.approveRun", "extension.revokeRun"]) {
      const err = await dispatchAutomationRpc({
        method,
        params: { id: "nope" },
        db,
        runGrantEnv: env,
        ownerGate: async () => true,
      }).catch((e: unknown) => e);
      expect((err as { rpcCode?: number }).rpcCode, method).toBe(-32602);
      expect((err as Error).message, method).toBe("Extension not found");
    }
  });

  test("a denial is -32603 and an unsatisfiable grant -32602", async () => {
    const { db, env } = await installed();
    const denied = await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => false,
    }).catch((e: unknown) => e);
    expect((denied as { rpcCode?: number }).rpcCode).toBe(-32603);
    expect((denied as Error).message).toMatch(/ERR_EXTENSION_RUN_NOT_APPROVED/);
  });

  test("list and info move no_grant → ready → grant_stale → no_grant", async () => {
    const { db, env, installPath } = await installed();
    expect((await listed(db))[0]).toMatchObject({ runState: "no_grant", runGrant: null });

    await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    expect((await listed(db))[0]).toMatchObject({
      runState: "ready",
      runGrant: { serviceId: "ext_rpc_run" },
    });
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "rpc.run" },
      db,
    })) as { value: { extension: { runState: string } } };
    expect(info.value.extension.runState).toBe("ready");

    writeFileSync(join(installPath, "dist", "chunk.js"), "export const v = 2;\n");
    setExtensionTreeDigest(db, "rpc.run", computeExtensionTreeDigest(installPath));
    expect((await listed(db))[0]?.runState).toBe("grant_stale");

    const stopped: string[] = [];
    const revoked = (await dispatchAutomationRpc({
      method: "extension.revokeRun",
      params: { id: "rpc.run" },
      db,
      mesh: {
        stopExtensionClient: async (id: string) => {
          stopped.push(id);
        },
      },
    })) as { value: { revoked: boolean } };
    expect(revoked.value.revoked).toBe(true);
    expect(stopped).toEqual(["rpc.run"]);
    expect((await listed(db))[0]).toMatchObject({ runState: "no_grant", runGrant: null });
  });

  test("approve and revoke announce extension.stateChanged; an unchanged re-approval does not", async () => {
    const { db, env } = await installed();
    const seen: Array<{ extensionId: string; action: string; ok: boolean }> = [];
    setGatewayEventBroadcast((method, params) => {
      const p = params as {
        kind?: string;
        payload?: { extensionId: string; action: string; ok: boolean };
      };
      if (method === "gateway.event" && p.kind === "extension.stateChanged" && p.payload) {
        seen.push(p.payload);
      }
    });
    try {
      const approve = () =>
        dispatchAutomationRpc({
          method: "extension.approveRun",
          params: { id: "rpc.run" },
          db,
          runGrantEnv: env,
          ownerGate: async () => true,
        });
      await approve();
      await approve();
      await dispatchAutomationRpc({ method: "extension.revokeRun", params: { id: "rpc.run" }, db });
      expect(seen.map((s) => `${s.action}:${String(s.ok)}`)).toEqual([
        "approveRun:true",
        "revokeRun:true",
      ]);
    } finally {
      setGatewayEventBroadcast(undefined);
    }
  });

  test("extension.remove removes the grant", async () => {
    const { db, env } = await installed();
    await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      ownerGate: async () => true,
    });
    await dispatchAutomationRpc({ method: "extension.remove", params: { id: "rpc.run" }, db });
    expect(getRunGrant(db, "rpc.run")).toBeNull();
  });
});

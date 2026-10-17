import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listExtensions, setExtensionTreeDigest } from "../automation/extension-store.ts";
import { getConnectorHealth, transitionHealth } from "../connectors/health.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import { LocalIndex } from "../index/local-index.ts";
import { type AutomationRpcExtensionMeshHandle, dispatchAutomationRpc } from "./automation-rpc.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function installed(permissions?: (root: string) => Record<string, unknown>): Promise<{
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
    JSON.stringify({
      id: "rpc.run",
      version: "1.0.0",
      entry: "dist/index.js",
      ...(permissions === undefined ? {} : { permissions: permissions(root) }),
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

function idleMesh(): AutomationRpcExtensionMeshHandle {
  return {
    stopExtensionClient: async () => {},
    isExtensionRunning: () => false,
    removeExtensionSandbox: async () => {},
  };
}

async function approve(db: Database, env: ExtensionRunGrantEnv): Promise<void> {
  await dispatchAutomationRpc({
    method: "extension.approveRun",
    params: { id: "rpc.run" },
    db,
    runGrantEnv: env,
    ownerGate: async () => true,
  });
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

    const p = await installed((root) => ({
      network: [],
      filesystem: { read: [join(root, "data")], write: [] },
    }));
    let asked = 0;
    const unsatisfiable = await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db: p.db,
      runGrantEnv: p.env,
      ownerGate: async () => {
        asked += 1;
        return true;
      },
    }).catch((e: unknown) => e);
    expect((unsatisfiable as { rpcCode?: number }).rpcCode).toBe(-32602);
    expect((unsatisfiable as Error).message).toMatch(/ERR_EXTENSION_GRANT_PROTECTED/);
    expect(asked).toBe(0);
    expect(getRunGrant(p.db, "rpc.run")).toBeNull();
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

    const events: string[] = [];
    const revoked = (await dispatchAutomationRpc({
      method: "extension.revokeRun",
      params: { id: "rpc.run" },
      db,
      mesh: {
        ...idleMesh(),
        stopExtensionClient: async (id: string) => {
          events.push(`stop:${id}`);
        },
        removeExtensionSandbox: async (serviceId: string) => {
          events.push(`sandbox:${serviceId}`);
        },
      },
    })) as { value: { revoked: boolean } };
    expect(revoked.value.revoked).toBe(true);
    // The child is stopped FIRST, then its stages are deleted (a revoke leaves no copy behind).
    expect(events).toEqual(["stop:rpc.run", "sandbox:ext_rpc_run"]);

    // A second revoke (nothing granted) deletes nothing.
    events.length = 0;
    await dispatchAutomationRpc({
      method: "extension.revokeRun",
      params: { id: "rpc.run" },
      db,
      mesh: {
        ...idleMesh(),
        stopExtensionClient: async (id: string) => {
          events.push(`stop:${id}`);
        },
        removeExtensionSandbox: async (serviceId: string) => {
          events.push(`sandbox:${serviceId}`);
        },
      },
    });
    expect(events).toEqual([]);
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

describe("the extension runtime over the automation dispatcher (PR 3)", () => {
  test("[extensions] runtime off: approveRun refuses ERR_EXTENSION_RUNTIME_DISABLED without asking", async () => {
    const { db, env } = await installed();
    let asked = 0;
    const err = await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run" },
      db,
      runGrantEnv: env,
      extensionsRuntimeEnabled: false,
      ownerGate: async () => {
        asked += 1;
        return true;
      },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/ERR_EXTENSION_RUNTIME_DISABLED/);
    expect((err as { rpcCode?: number }).rpcCode).toBe(-32602);
    expect(asked).toBe(0);
    expect(getRunGrant(db, "rpc.run")).toBeNull();
  });

  test("list and info report running when the mesh holds a live client, ready when not", async () => {
    const { db, env } = await installed();
    await approve(db, env);
    const running = { ...idleMesh(), isExtensionRunning: (id: string) => id === "rpc.run" };
    const list = (await dispatchAutomationRpc({
      method: "extension.list",
      params: {},
      db,
      mesh: running,
    })) as { value: { extensions: ListItem[] } };
    expect(list.value.extensions[0]?.runState).toBe("running");
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "rpc.run" },
      db,
      mesh: running,
    })) as { value: { extension: { runState: string } } };
    expect(info.value.extension.runState).toBe("running");
    const idle = (await dispatchAutomationRpc({
      method: "extension.list",
      params: {},
      db,
      mesh: idleMesh(),
    })) as { value: { extensions: ListItem[] } };
    expect(idle.value.extensions[0]?.runState).toBe("ready");
  });

  test("a disabled extension the mesh still maps reports disabled, not running", async () => {
    const { db, env } = await installed();
    await approve(db, env);
    await dispatchAutomationRpc({ method: "extension.disable", params: { id: "rpc.run" }, db });
    const list = (await dispatchAutomationRpc({
      method: "extension.list",
      params: {},
      db,
      mesh: { ...idleMesh(), isExtensionRunning: () => true },
    })) as { value: { extensions: ListItem[] } };
    expect(list.value.extensions[0]?.runState).toBe("disabled");
  });

  test("extension.remove: withdraws the row, THEN stops the client and removes its sandbox leaf, THEN deletes the install dir", async () => {
    const { db, env, installPath } = await installed();
    await approve(db, env);
    const events: string[] = [];
    const state = () =>
      `row=${String(listExtensions(db).some((r) => r.id === "rpc.run"))},grant=${String(
        getRunGrant(db, "rpc.run") !== null,
      )},dir=${String(existsSync(installPath))}`;
    await dispatchAutomationRpc({
      method: "extension.remove",
      params: { id: "rpc.run" },
      db,
      mesh: {
        stopExtensionClient: async (id) => {
          events.push(`stop:${id}:${state()}`);
        },
        isExtensionRunning: () => true,
        removeExtensionSandbox: async (serviceId) => {
          events.push(`sandbox:${serviceId}:${state()}`);
        },
      },
    });
    expect(events).toEqual([
      "stop:rpc.run:row=false,grant=false,dir=true",
      "sandbox:ext_rpc_run:row=false,grant=false,dir=true",
    ]);
    expect(existsSync(installPath)).toBe(false);
  });

  test("extension.remove with no grant (revoked earlier) still removes the DERIVED service id's stages", async () => {
    const { db } = await installed();
    const events: string[] = [];
    await dispatchAutomationRpc({
      method: "extension.remove",
      params: { id: "rpc.run" },
      db,
      mesh: {
        stopExtensionClient: async (id) => {
          events.push(`stop:${id}`);
        },
        isExtensionRunning: () => false,
        removeExtensionSandbox: async (serviceId) => {
          events.push(`sandbox:${serviceId}`);
        },
      },
    });
    expect(events).toEqual(["stop:rpc.run", "sandbox:ext_rpc_run"]);
  });

  test("extension.remove deletes the ext_ health row a refused spawn recorded", async () => {
    const { db, env } = await installed();
    await approve(db, env);
    transitionHealth(db, "ext_rpc_run", {
      type: "persistent_error",
      error: "ERR_EXTENSION_RUN_TREE_CHANGED",
    });
    expect(getConnectorHealth(db, "ext_rpc_run").state).toBe("error");
    await dispatchAutomationRpc({
      method: "extension.remove",
      params: { id: "rpc.run" },
      db,
      mesh: idleMesh(),
    });
    const row = db
      .query("SELECT COUNT(*) AS c FROM sync_state WHERE connector_id = ?")
      .get("ext_rpc_run") as { c: number };
    expect(row.c).toBe(0);
    expect(getConnectorHealth(db, "ext_rpc_run").state).toBe("not_configured");
  });

  test("extension.remove still completes when the stop hook throws", async () => {
    const { db, env, installPath } = await installed();
    await approve(db, env);
    const out = (await dispatchAutomationRpc({
      method: "extension.remove",
      params: { id: "rpc.run" },
      db,
      mesh: {
        ...idleMesh(),
        stopExtensionClient: async () => {
          throw new Error("stop failed");
        },
      },
    })) as { value: { ok: boolean } };
    expect(out.value.ok).toBe(true);
    expect(existsSync(installPath)).toBe(false);
  });

  test("extension.disable stops the client only after the row reads disabled, and awaits it", async () => {
    const { db } = await installed();
    let stoppedWhileEnabled: boolean | undefined;
    let settled = false;
    await dispatchAutomationRpc({
      method: "extension.disable",
      params: { id: "rpc.run" },
      db,
      mesh: {
        ...idleMesh(),
        stopExtensionClient: async () => {
          stoppedWhileEnabled = listExtensions(db).find((r) => r.id === "rpc.run")?.enabled === 1;
          await Promise.resolve();
          settled = true;
        },
      },
    });
    expect(stoppedWhileEnabled).toBe(false);
    expect(settled).toBe(true);
  });
});

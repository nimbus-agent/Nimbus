import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import {
  installStarterPackFixture,
  PACK_FIXTURE,
  TOP_PACK_REFUSAL,
} from "../../test/helpers/starter-pack-fixture.ts";
import { listExtensions, setExtensionTreeDigest } from "../automation/extension-store.ts";
import { getConnectorHealth, transitionHealth } from "../connectors/health.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import { getRunGrant } from "../extensions/run-grant-store.ts";
import { computeExtensionTreeDigest } from "../extensions/tree-digest.ts";
import {
  recordTrustStatements,
  replaceCurrentVerifications,
} from "../extensions/trust/trust-store.ts";
import { encodeBase64 } from "../extensions/verify-signature.ts";
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

type ListItem = {
  id: string;
  runState: string;
  runGrant: { serviceId: string } | null;
  verifiedPublisher?: unknown;
  publisher?: unknown;
};

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

  test("extension.list reports runtimeEnabled (default true)", async () => {
    const { db } = await installed();
    const read = async (extensionsRuntimeEnabled?: boolean) =>
      (
        (await dispatchAutomationRpc({
          method: "extension.list",
          params: {},
          db,
          ...(extensionsRuntimeEnabled === undefined ? {} : { extensionsRuntimeEnabled }),
        })) as { value: { runtimeEnabled: boolean } }
      ).value.runtimeEnabled;
    expect(await read(false)).toBe(false);
    expect(await read(true)).toBe(true);
    expect(await read()).toBe(true);
  });

  test("a non-boolean modelAccess is -32602 and announces nothing", async () => {
    const { db, env } = await installed();
    const events: string[] = [];
    setGatewayEventBroadcast((method) => {
      events.push(method);
    });
    try {
      for (const modelAccess of ["yes", 1, null]) {
        const err = await dispatchAutomationRpc({
          method: "extension.approveRun",
          params: { id: "rpc.run", modelAccess },
          db,
          runGrantEnv: env,
          ownerGate: async () => true,
        }).catch((e: unknown) => e);
        expect((err as { rpcCode?: number }).rpcCode, String(modelAccess)).toBe(-32602);
        expect((err as Error).message).toBe("Invalid params: 'modelAccess' must be a boolean");
      }
      expect(events).toEqual([]);
      expect(getRunGrant(db, "rpc.run")).toBeNull();
    } finally {
      setGatewayEventBroadcast(undefined);
    }
  });

  test("modelAccess: true reaches the grant and the result", async () => {
    const { db, env } = await installed();
    const out = (await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: "rpc.run", modelAccess: true },
      db,
      runGrantEnv: env,
      ownerGate: async () => true,
    })) as { value: { modelAccess: boolean } };
    expect(out.value.modelAccess).toBe(true);
    expect(getRunGrant(db, "rpc.run")?.model_access).toBe(1);
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

describe("extension.list / extension.info show a blocked extension (I48)", () => {
  test("a Nimbus takedown makes it blocked, with the block listed", async () => {
    const { db } = await installed();
    // Give the installed copy a publisher (display only: list/info read the hash-checked manifest).
    const installPath = listExtensions(db)[0]?.install_path ?? "";
    const manifestPath = join(installPath, "nimbus.extension.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    m["publisher"] = { id: "acme", key: encodeBase64(new Uint8Array(32).fill(7)) };
    m["signature"] = `${"A".repeat(86)}==`;
    writeFileSync(manifestPath, JSON.stringify(m));
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = 'rpc.run'", [
      createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    ]);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: "rpc.run",
        publisherId: "acme",
        versions: "*",
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);

    const item = (await listed(db))[0] as ListItem & { blockedBy: Array<{ reason: string }> };
    expect(item.runState).toBe("blocked");
    expect(item.blockedBy.map((b) => b.reason)).toEqual(["malware"]);
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "rpc.run" },
      db,
    })) as { value: { extension: { runState: string; blockedBy: unknown[] } } };
    expect(info.value.extension.runState).toBe("blocked");
    expect(info.value.extension.blockedBy).toHaveLength(1);
  });
});

describe("extension.list / extension.info report the verified publisher (R6)", () => {
  test("listed when the current Nimbus verification names the verifying key; none otherwise", async () => {
    const { db } = await installed();
    const installPath = listExtensions(db)[0]?.install_path ?? "";
    const manifestPath = join(installPath, "nimbus.extension.json");
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const publisherKey = encodeBase64(new Uint8Array(32).fill(7));
    m["publisher"] = { id: "acme", key: publisherKey };
    m["signature"] = `${"A".repeat(86)}==`;
    writeFileSync(manifestPath, JSON.stringify(m));
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = 'rpc.run'", [
      createHash("sha256").update(readFileSync(manifestPath)).digest("hex"),
    ]);
    // A registry-installed copy (R6 as amended 2026-10-27: a local-path copy never carries the badge).
    db.run(
      "UPDATE extension SET source_registry = 'main', source_root_fingerprint = ? WHERE id = 'rpc.run'",
      ["c".repeat(32)],
    );
    expect((await listed(db))[0]?.verifiedPublisher).toBeNull();
    // The verified manifest's publisher reaches the CLI (it renders the id, the key and the badge).
    expect((await listed(db))[0]?.publisher).toEqual({ id: "acme", key: publisherKey });
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 15);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const vouch = await signTrustStatement(
      {
        kind: "publisher.verified",
        issuedAt: "2026-10-27T12:00:00Z",
        signerKey: nimbusKey,
        publisherId: "acme",
        keys: [publisherKey],
        github: "acme-dev",
        verifiedAt: "2026-10-20T00:00:00Z",
      },
      seed,
    );
    replaceCurrentVerifications(db, [vouch], nimbusKey, 1);
    const badge = { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" };
    expect((await listed(db))[0]?.verifiedPublisher).toEqual(badge);
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: "rpc.run" },
      db,
    })) as { value: { extension: { verifiedPublisher: unknown } } };
    expect(info.value.extension.verifiedPublisher).toEqual(badge);
    expect((info.value.extension as { publisher?: unknown }).publisher).toEqual({
      id: "acme",
      key: publisherKey,
    });
    // The same copy recorded as a local-path install shows no badge.
    db.run(
      "UPDATE extension SET source_registry = NULL, source_root_fingerprint = NULL WHERE id = 'rpc.run'",
    );
    expect((await listed(db))[0]?.verifiedPublisher).toBeNull();
    db.run(
      "UPDATE extension SET source_registry = 'main', source_root_fingerprint = ? WHERE id = 'rpc.run'",
      ["c".repeat(32)],
    );
    // A copy that no longer matches its installed hashes (a tampered entry file, which a boot pass
    // disables for the hash without ever marking the signature registry) never carries the badge.
    const entry = join(installPath, "dist", "index.js");
    writeFileSync(
      entry,
      `${readFileSync(entry, "utf8")}
// tampered
`,
    );
    expect((await listed(db))[0]?.verifiedPublisher).toBeNull();
  });
});

describe("a starter pack over the automation dispatcher", () => {
  async function packs() {
    const fx = await installStarterPackFixture("nimbus-rpc-pack-");
    cleanups.push(fx.cleanup);
    return fx;
  }

  test("extension.list and extension.info carry kind, and a pack's run state is `pack`", async () => {
    const fx = await packs();
    const items = (await listed(fx.db)) as Array<ListItem & { kind?: string }>;
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(PACK_FIXTURE.topPack)?.kind).toBe("starter-pack");
    expect(byId.get(PACK_FIXTURE.topPack)?.runState).toBe("pack");
    expect(byId.get(PACK_FIXTURE.topPack)?.runGrant).toBeNull();
    expect(byId.get(PACK_FIXTURE.codeA)?.kind).toBe("extension");
    expect(byId.get(PACK_FIXTURE.codeA)?.runState).toBe("no_grant");
    const info = (await dispatchAutomationRpc({
      method: "extension.info",
      params: { id: PACK_FIXTURE.subPack },
      db: fx.db,
    })) as { value: { extension: { kind?: string; runState: string } } };
    expect(info.value.extension.kind).toBe("starter-pack");
    expect(info.value.extension.runState).toBe("pack");
  });

  test("extension.approveRun on a pack refuses with the member commands and never asks the owner", async () => {
    const fx = await packs();
    let asked = 0;
    const err = await dispatchAutomationRpc({
      method: "extension.approveRun",
      params: { id: PACK_FIXTURE.topPack },
      db: fx.db,
      runGrantEnv: fx.env,
      ownerGate: async () => {
        asked++;
        return true;
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { rpcCode?: number }).rpcCode).toBe(-32602);
    expect((err as Error).message).toBe(`ERR_EXTENSION_STARTER_PACK: ${TOP_PACK_REFUSAL}`);
    expect(asked).toBe(0);
    expect(getRunGrant(fx.db, PACK_FIXTURE.topPack)).toBeNull();
  });
});

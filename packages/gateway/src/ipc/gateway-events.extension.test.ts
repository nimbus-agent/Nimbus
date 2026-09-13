import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { AutoUpdateCache } from "../extensions/auto-update-cache.ts";
import type { AutoUpdateRpcDeps } from "../extensions/auto-update-rpc.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAutomationRpc } from "./automation-rpc.ts";
import {
  type ExtensionStateChangedPayload,
  emitGatewayEvent,
  setGatewayEventBroadcast,
} from "./gateway-events.ts";

afterEach(() => setGatewayEventBroadcast(undefined));

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Never actually invoked below: `resolveUpdateTarget` returns `cache_miss` before touching
 * any of these, since the cache is empty for the requested id/toVersion pair. */
function stubAutoUpdateDeps(): AutoUpdateRpcDeps {
  return {
    cache: new AutoUpdateCache(),
    forcePoll: async () => {},
    gate: async () => "proceed",
    performUpgrade: async () => {},
    performDowngrade: async () => {},
    appendAudit: async () => {},
    getInstalledVersion: async () => null,
    hasPrevVersion: async () => false,
  };
}

describe("extension.stateChanged", () => {
  test("covers the five RUNTIME mutations, not the boot verification pass", () => {
    // `verifyExtensionsBestEffort` runs ONCE at boot (`assemble.ts:3309`), before anyone is
    // tailing, so a signature-disable is not a streamable event — `nimbus extension list`/`info`
    // already surface it. Only owner-initiated IPC mutations happen while someone is watching.
    const actions: ExtensionStateChangedPayload["action"][] = [
      "install",
      "enable",
      "disable",
      "remove",
      "update",
    ];
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    for (const action of actions) {
      emitGatewayEvent("extension.stateChanged", { extensionId: "nimbus-jira", action, ok: true });
    }
    expect(seen).toHaveLength(5);
    expect(
      seen.map((s) => (s as { payload: ExtensionStateChangedPayload }).payload.action),
    ).toEqual(actions);
  });

  test("a failed mutation is reported with ok:false and its error", () => {
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    emitGatewayEvent("extension.stateChanged", {
      extensionId: "nimbus-jira",
      action: "install",
      ok: false,
      error: "signature verification failed",
    });
    const p = seen[0] as { payload: ExtensionStateChangedPayload };
    expect(p.payload.ok).toBe(false);
    expect(p.payload.error).toBe("signature verification failed");
  });

  test("a non-applied update (no thrown error) still reports its specific reason", async () => {
    // dispatchAutoUpdateRpc's `resolveUpdateTarget` returns `{applied:false, reason:"cache_miss"}`
    // for an id with nothing cached — a NORMAL result, not a thrown error — so this exercises the
    // wiring's success branch, not its catch branch.
    const seen: Array<Record<string, unknown>> = [];
    setGatewayEventBroadcast((_m, params) => seen.push(params));
    const db = seededDb();
    const out = await dispatchAutomationRpc({
      method: "extension.update",
      params: { id: "com.example.a", toVersion: "2.0.0" },
      db,
      autoUpdate: stubAutoUpdateDeps(),
    });
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      expect((out.value as { applied: boolean }).applied).toBe(false);
    }
    expect(seen).toHaveLength(1);
    const p = seen[0] as { payload: ExtensionStateChangedPayload };
    expect(p.payload.ok).toBe(false);
    expect(p.payload.error).toBe("cache_miss");
  });
});

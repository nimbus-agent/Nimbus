import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../config/oncall-push-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { PushRetryRefusedError } from "../oncall-push/push-runner.ts";
import type { OncallPushRuntime } from "../oncall-push/push-runtime.ts";
import { PushStore } from "../oncall-push/push-store.ts";
import { dispatchOncallPushRpc, OncallPushRpcError } from "./oncall-push-rpc.ts";

let db: Database;
let store: PushStore;
const runtime = (over: Partial<OncallPushRuntime> = {}): OncallPushRuntime => ({
  config: { ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true },
  store,
  run: async () => ({ selected: 0, ok: 0, failed: 0 }),
  trigger: () => {},
  retry: async () => {
    throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FAILED", "x");
  },
  identityResolved: async () => true,
  ...over,
});
beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
});
afterEach(() => db.close());

const hit = async (m: string, p: unknown, rt = runtime()) => {
  const out = await dispatchOncallPushRpc(m, p, { runtime: rt });
  if (out.kind !== "hit") throw new Error(`miss: ${m}`);
  return out.value as Record<string, unknown>;
};

test("pushedList: empty, with status", async () => {
  expect(await hit("oncall.pushedList", {})).toEqual({
    enabled: true,
    identity: "resolved",
    briefs: [],
  });
});

test("pushedList / pushedGet return rows, newest when no id", async () => {
  store.insert(
    "pagerduty:A",
    { status: "ok", sessionId: "s", briefMarkdown: "# A", briefJson: "{}" },
    1,
  );
  store.insert("pagerduty:B", { status: "failed", sessionId: null, failureCode: "timeout: x" }, 2);
  const list = await hit("oncall.pushedList", { limit: 10 });
  expect((list["briefs"] as { incidentId: string }[]).map((b) => b.incidentId)).toEqual([
    "pagerduty:B",
    "pagerduty:A",
  ]);
  expect((await hit("oncall.pushedGet", {}))["brief"]).toMatchObject({
    incidentId: "pagerduty:B",
    failureCode: "timeout: x",
  });
  expect((await hit("oncall.pushedGet", { incidentId: "pagerduty:A" }))["brief"]).toMatchObject({
    briefMarkdown: "# A",
  });
  expect((await hit("oncall.pushedGet", { incidentId: "pagerduty:NOPE" }))["brief"]).toBeNull();
});

test("bad params are -32602", async () => {
  for (const [m, p] of [
    ["oncall.pushedList", { limit: 0 }],
    ["oncall.pushedList", { limit: 201 }],
    ["oncall.pushedGet", { incidentId: 5 }],
    ["oncall.pushedRetry", {}],
    ["oncall.pushedList", []],
  ] as const) {
    await expect(dispatchOncallPushRpc(m, p, { runtime: runtime() })).rejects.toMatchObject({
      rpcCode: -32602,
    });
  }
});

test("retry maps refusals to named codes", async () => {
  await expect(
    dispatchOncallPushRpc(
      "oncall.pushedRetry",
      { incidentId: "pagerduty:A" },
      { runtime: runtime() },
    ),
  ).rejects.toMatchObject({ rpcCode: -32002 });
  const notFound = runtime({
    retry: async () => {
      throw new PushRetryRefusedError("ERR_ONCALL_PUSH_NOT_FOUND", "x");
    },
  });
  await expect(
    dispatchOncallPushRpc(
      "oncall.pushedRetry",
      { incidentId: "pagerduty:A" },
      { runtime: notFound },
    ),
  ).rejects.toBeInstanceOf(OncallPushRpcError);
});

test("an unknown oncall.* method misses (falls through to Method not found)", async () => {
  expect((await dispatchOncallPushRpc("oncall.nope", {}, { runtime: runtime() })).kind).toBe(
    "miss",
  );
});

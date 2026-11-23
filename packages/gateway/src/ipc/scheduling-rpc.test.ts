import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BLOCK_MS, floorToBlock } from "../federation/_lib/free-busy-blocks.ts";
import { scheduleConsent } from "../federation/schedule-consent-broker.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { dispatchSchedulingRpc, type SchedulingRpcCtx } from "./scheduling-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

let index: LocalIndex;
const NOW = Date.now();
const FROM = floorToBlock(NOW) + 2 * BLOCK_MS;
const TO = FROM + 4 * BLOCK_MS;

beforeEach(() => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
  index = new LocalIndex(db);
  db.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('apple', ?)", [NOW]);
  index.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(7),
    direction: "outbound",
    hostIp: "10.0.0.5",
    hostPort: 7475,
  });
});
afterEach(() => {
  scheduleConsent.clear();
  index.close();
});

function ctx(kind: ClientKind, over: Partial<SchedulingRpcCtx> = {}): SchedulingRpcCtx {
  return {
    index,
    selfIdentity: generateBoxKeypair(),
    consentTimeoutMs: 1000,
    callerKind: kind,
    now: () => NOW,
    ...over,
  };
}
const call = (method: string, params: unknown, c: SchedulingRpcCtx) =>
  dispatchSchedulingRpc(method, params, c);
const errorOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("only the owner's own surfaces are served", () => {
  for (const kind of ["mcp", "http", "chatops", "fleet", "push", "unknown"] as const) {
    test(`${kind} is refused for both methods`, async () => {
      expect(await errorOf(call("scheduling.ask", {}, ctx(kind)))).toMatch(/FORBIDDEN_CLIENT/);
      expect(await errorOf(call("scheduling.respond", {}, ctx(kind)))).toMatch(/FORBIDDEN_CLIENT/);
    });
  }
  test("an unknown method misses", async () => {
    expect((await call("scheduling.other", {}, ctx("cli"))).kind).toBe("miss");
  });
});

describe("scheduling.ask", () => {
  const params = { peerId: "peer:aa", fromMs: FROM, toMs: TO, durationMin: 30 };
  test("sends federation.freeBusy to the paired peer and returns the slots", async () => {
    const sent: Array<{ method: string; params: unknown; timeout: unknown }> = [];
    const out = await call(
      "scheduling.ask",
      params,
      ctx("cli", {
        sendOverWire: async (_h, _p, _kp, _pk, method, p, timeout) => {
          sent.push({ method, params: p, timeout });
          return { kind: "ok", reply: { fromMs: FROM, blockMs: BLOCK_MS, blocks: "0100" } };
        },
      }),
    );
    expect(sent).toEqual([
      { method: "federation.freeBusy", params: { fromMs: FROM, toMs: TO }, timeout: 16_000 },
    ]);
    expect(out).toMatchObject({
      kind: "hit",
      value: { kind: "ok", slots: [{ startMs: FROM }, { startMs: FROM + 2 * BLOCK_MS }] },
    });
  });
  test("an unknown peer and a bad duration are parameter errors", async () => {
    expect(
      await errorOf(call("scheduling.ask", { ...params, peerId: "peer:zz" }, ctx("cli"))),
    ).toMatch(/ERR_UNKNOWN_PEER/);
    for (const d of [0, 14, 481, 30.5, "30"]) {
      expect(
        await errorOf(call("scheduling.ask", { ...params, durationMin: d }, ctx("ui"))),
      ).toMatch(/durationMin/);
    }
    expect(await errorOf(call("scheduling.ask", "x", ctx("cli")))).toMatch(/ERR_INVALID_PARAMS/);
  });
  test("a missing identity fails closed", async () => {
    expect(
      await errorOf(call("scheduling.ask", params, ctx("cli", { selfIdentity: undefined }))),
    ).toMatch(/ERR_FEDERATION_ASKER_UNAVAILABLE/);
  });
});

describe("scheduling.respond", () => {
  async function pending(): Promise<{ id: string; answer: Promise<boolean> }> {
    let id = "";
    scheduleConsent.setBroadcast((_m, p) => {
      id = (p as { requestId: string }).requestId;
    });
    const answer = scheduleConsent.request({ peerId: "peer:aa", fromMs: FROM, toMs: TO }, 5000);
    return { id, answer };
  }
  test("a person at the terminal approves", async () => {
    const { id, answer } = await pending();
    const r = await call(
      "scheduling.respond",
      { requestId: id, approved: true, answerSource: "human" },
      ctx("cli"),
    );
    expect(r).toMatchObject({ kind: "hit", value: { matched: true } });
    expect(await answer).toBe(true);
  });
  test("an approval that is not from a person is a decline", async () => {
    for (const answerSource of [undefined, "auto", "script", "unknown", "delegate", "remote"]) {
      const { id, answer } = await pending();
      await call(
        "scheduling.respond",
        { requestId: id, approved: true, ...(answerSource === undefined ? {} : { answerSource }) },
        ctx("cli"),
      );
      expect(await answer).toBe(false);
    }
  });
  test("a denial denies, and an unknown or settled id matches nothing", async () => {
    const { id, answer } = await pending();
    await call("scheduling.respond", { requestId: id, answerSource: "human" }, ctx("ui"));
    expect(await answer).toBe(false);
    const again = await call(
      "scheduling.respond",
      { requestId: id, approved: true, answerSource: "human" },
      ctx("ui"),
    );
    expect(again).toMatchObject({ value: { matched: false } });
  });
});

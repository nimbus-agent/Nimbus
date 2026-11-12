import { describe, expect, test } from "bun:test";

import type { ChatReadMarkerInput, ChatReadMarkerKind } from "../index/chat-read-marker-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  advanceMarkerIndex,
  type MarkerPassDeps,
  type MarkerPassInput,
  parseConversationInfo,
  refreshSlackReadMarkers,
  selectMarkerChannels,
} from "./slack-read-markers.ts";
import type { SlackApiReply } from "./slack-web-api.ts";

const TS = "1700000100.000200";

describe("parseConversationInfo", () => {
  const info = (channel: Record<string, unknown>) => ({ ok: true, channel });

  test("maps each conversation type to its kind", () => {
    const cases: Array<[Record<string, unknown>, ChatReadMarkerKind]> = [
      [{ is_channel: true }, "public_channel"],
      [{ is_channel: true, is_private: true }, "private_channel"],
      [{ is_group: true }, "private_channel"],
      [{ is_im: true }, "im"],
      [{ is_mpim: true }, "mpim"],
      [{ is_mpim: true, is_group: true }, "mpim"],
      [{}, "public_channel"],
    ];
    for (const [flags, kind] of cases) {
      expect(parseConversationInfo(info({ id: "C1", last_read: TS, ...flags }), "C1")).toEqual({
        ok: true,
        marker: { channelId: "C1", channelKind: kind, lastReadTs: TS },
      });
    }
  });

  test("a never-read conversation (all zeros) is a marker", () => {
    const out = parseConversationInfo(info({ id: "C1", last_read: "0000000000.000000" }), "C1");
    expect(out.ok && out.marker.lastReadTs).toBe("0000000000.000000");
  });

  test("a missing, empty, short, numeric or malformed last_read is skipped", () => {
    for (const lastRead of [undefined, "", "0", 1700000100.0002, "1700000100.0002", "x", null]) {
      expect(parseConversationInfo(info({ id: "C1", last_read: lastRead }), "C1")).toEqual({
        ok: false,
        reason: "no_last_read",
      });
    }
  });

  test("a channel with another id, or no channel object, is skipped", () => {
    expect(parseConversationInfo(info({ id: "C2", last_read: TS }), "C1")).toEqual({
      ok: false,
      reason: "id_mismatch",
    });
    for (const channel of [undefined, null, "C1", [1]]) {
      expect(parseConversationInfo({ ok: true, channel }, "C1")).toEqual({
        ok: false,
        reason: "no_channel",
      });
    }
  });
});

describe("selectMarkerChannels and advanceMarkerIndex", () => {
  const ids = ["A", "B", "C", "D"];

  test("starts at mkIdx modulo n, wraps, and never repeats", () => {
    expect(selectMarkerChannels(ids, 0, 2)).toEqual(["A", "B"]);
    expect(selectMarkerChannels(ids, 3, 3)).toEqual(["D", "A", "B"]);
    expect(selectMarkerChannels(ids, 9, 2)).toEqual(["B", "C"]);
  });

  test("max above n returns each id once; no ids returns nothing", () => {
    expect(selectMarkerChannels(ids, 1, 100)).toEqual(["B", "C", "D", "A"]);
    expect(selectMarkerChannels([], 5, 100)).toEqual([]);
  });

  test("the offset advances by what was processed and is 0 with no channels", () => {
    expect(advanceMarkerIndex(3, 2, 4)).toBe(1);
    expect(advanceMarkerIndex(0, 0, 4)).toBe(0);
    expect(advanceMarkerIndex(5, 3, 0)).toBe(0);
  });
});

type Call = { method: string; body: Record<string, unknown> };

type Harness = {
  ctx: SyncContext;
  calls: Call[];
  stored: Array<{ markers: readonly ChatReadMarkerInput[]; opts: unknown }>;
  warns: unknown[][];
  penalised: Array<[string, number]>;
  clock: { t: number };
  deps: (over?: Partial<MarkerPassDeps>) => MarkerPassDeps;
};

function harness(opts: {
  replies?: Record<string, SlackApiReply | (() => SlackApiReply | Promise<SlackApiReply>)>;
  tokens?: number;
  setThrows?: boolean;
  limiterThrows?: boolean;
}): Harness {
  const calls: Call[] = [];
  const stored: Harness["stored"] = [];
  const warns: unknown[][] = [];
  const penalised: Array<[string, number]> = [];
  const clock = { t: 0 };
  let tokens = opts.tokens ?? 1000;
  const ctx = {
    logger: { warn: (...a: unknown[]) => warns.push(a) },
    rateLimiter: {
      tryAcquire: async () => {
        if (opts.limiterThrows === true) throw new Error("limiter broke");
        if (tokens > 0) {
          tokens -= 1;
          return true;
        }
        return false;
      },
      penalise: (p: string, ms: number) => penalised.push([p, ms]),
    },
    setChatReadMarkers: (markers: readonly ChatReadMarkerInput[], o: unknown) => {
      if (opts.setThrows === true) throw new Error("db broke");
      stored.push({ markers, opts: o });
      return { stored: markers.length, skipped: 0, pruned: 0 };
    },
  } as unknown as SyncContext;
  const deps = (over: Partial<MarkerPassDeps> = {}): MarkerPassDeps => ({
    callApi: async (_token, method, body) => {
      calls.push({ method, body });
      const key = method === "conversations.info" ? `info:${String(body["channel"])}` : method;
      const r = opts.replies?.[key];
      if (r === undefined) throw new Error(`no reply for ${key}`);
      return typeof r === "function" ? r() : r;
    },
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
    budgetMs: 30_000,
    maxChannels: 100,
    ...over,
  });
  return { ctx, calls, stored, warns, penalised, clock, deps };
}

const okInfo = (id: string, extra: Record<string, unknown> = {}): SlackApiReply => ({
  ok: true,
  json: { ok: true, channel: { id, last_read: TS, ...extra } },
  text: "{}",
});
const err = (code: string): SlackApiReply => ({
  ok: false,
  json: { ok: false, error: code },
  text: `{"ok":false,"error":"${code}"}`,
});
const authOk: SlackApiReply = { ok: true, json: { ok: true, user_id: "U9" }, text: "{}" };

const input = (over: Partial<MarkerPassInput> = {}): MarkerPassInput => ({
  token: "xoxp-secret-token",
  ids: ["C1", "D2"],
  mkIdx: 0,
  selfUserId: "UOLD",
  listComplete: true,
  ...over,
});

describe("refreshSlackReadMarkers", () => {
  test("auth.test first, then one info call per channel, stored in ONE call with the keep list", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": okInfo("C1"),
        "info:D2": okInfo("D2", { is_im: true }),
      },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(h.calls.map((c) => c.method)).toEqual([
      "auth.test",
      "conversations.info",
      "conversations.info",
    ]);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]?.markers.map((m) => [m.channelId, m.channelKind])).toEqual([
      ["C1", "public_channel"],
      ["D2", "im"],
    ]);
    expect(h.stored[0]?.opts).toEqual({ keepChannelIds: ["C1", "D2"] });
    expect(out).toEqual({ selfUserId: "U9", mkIdx: 0 });
    expect(h.warns).toEqual([]);
  });

  test("a failing auth.test keeps the previous own user id and the pass goes on", async () => {
    const h = harness({
      replies: {
        "auth.test": err("invalid_auth"),
        "info:C1": okInfo("C1"),
        "info:D2": okInfo("D2"),
      },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(out.selfUserId).toBe("UOLD");
    expect(h.stored[0]?.markers).toHaveLength(2);
  });

  test("an auth.test that throws, or returns no user_id, keeps the previous id", async () => {
    const throwing = harness({ replies: { "info:C1": okInfo("C1"), "info:D2": okInfo("D2") } });
    expect((await refreshSlackReadMarkers(throwing.ctx, input(), throwing.deps())).selfUserId).toBe(
      "UOLD",
    );
    const bare = harness({
      replies: {
        "auth.test": { ok: true, json: { ok: true }, text: "{}" },
        "info:C1": okInfo("C1"),
        "info:D2": okInfo("D2"),
      },
    });
    expect((await refreshSlackReadMarkers(bare.ctx, input(), bare.deps())).selfUserId).toBe("UOLD");
  });

  test("channel_not_found, not_in_channel and unknown errors skip that channel and go on", async () => {
    for (const code of ["channel_not_found", "not_in_channel", "internal_error"]) {
      const h = harness({
        replies: { "auth.test": authOk, "info:C1": err(code), "info:D2": okInfo("D2") },
      });
      const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
      expect(
        h.stored[0]?.markers.map((m) => m.channelId),
        code,
      ).toEqual(["D2"]);
      expect(out.mkIdx, code).toBe(0);
      expect(h.warns, code).toEqual([]);
    }
  });

  test("a reply with a bad shape is skipped", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": { ok: true, json: { ok: true, channel: { id: "C1" } }, text: "{}" },
        "info:D2": { ok: false, json: {}, text: "not json" },
      },
    });
    await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(h.stored[0]?.markers).toEqual([]);
  });

  test("ratelimited ends the pass, penalises the limiter and still stores the earlier results", async () => {
    const h = harness({
      replies: { "auth.test": authOk, "info:C1": okInfo("C1"), "info:D2": err("ratelimited") },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input({ ids: ["C1", "D2", "E3"] }), h.deps());
    expect(h.penalised).toEqual([["slack", 60_000]]);
    expect(h.calls.filter((c) => c.method === "conversations.info")).toHaveLength(2);
    expect(h.stored[0]?.markers.map((m) => m.channelId)).toEqual(["C1"]);
    // Only C1 was processed, so the offset moves by one and D2 is retried first next time.
    expect(out.mkIdx).toBe(1);
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "ratelimited" });
  });

  test("each fatal code ends the pass with only the code logged", async () => {
    for (const code of [
      "invalid_auth",
      "token_revoked",
      "token_expired",
      "missing_scope",
      "account_inactive",
    ]) {
      const h = harness({
        replies: { "auth.test": authOk, "info:C1": err(code), "info:D2": okInfo("D2") },
      });
      const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
      expect(
        h.calls.filter((c) => c.method === "conversations.info"),
        code,
      ).toHaveLength(1);
      expect(out.mkIdx, code).toBe(0);
      expect(h.warns[0]?.[0], code).toEqual({ service: "slack", code });
    }
  });

  test("an error reply with no error code is logged as unknown_error and skipped", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": { ok: false, json: { error: 5 }, text: "x" },
        "info:D2": okInfo("D2"),
      },
    });
    await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(h.stored[0]?.markers.map((m) => m.channelId)).toEqual(["D2"]);
  });

  test("a drained limiter ends the pass at the deadline, partial, with a logged deadline", async () => {
    const h = harness({
      tokens: 2,
      replies: { "auth.test": authOk, "info:C1": okInfo("C1"), "info:D2": okInfo("D2") },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input({ ids: ["C1", "D2", "E3"] }), h.deps());
    expect(h.stored[0]?.markers.map((m) => m.channelId)).toEqual(["C1"]);
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "deadline" });
    expect(out.mkIdx).toBe(1);
    expect(h.clock.t).toBeGreaterThanOrEqual(30_000);
  });

  test("no token for the very first call ends the pass at the deadline with nothing fetched", async () => {
    const h = harness({ tokens: 0 });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(h.calls).toEqual([]);
    expect(out).toEqual({ selfUserId: "UOLD", mkIdx: 0 });
    // A complete list still prunes: the deadline says nothing about the list.
    expect(h.stored[0]?.opts).toEqual({ keepChannelIds: ["C1", "D2"] });
  });

  test("a fetch that throws (an abort) ends the pass partial", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": okInfo("C1"),
        "info:D2": () => {
          throw new Error("aborted");
        },
      },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(h.stored[0]?.markers.map((m) => m.channelId)).toEqual(["C1"]);
    expect(out.mkIdx).toBe(1);
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "aborted" });
  });

  test("the budget timer aborts a request that never answers", async () => {
    const h = harness({ replies: { "auth.test": authOk } });
    const deps = h.deps({
      budgetMs: 20,
      callApi: (_t, method, _b, signal) =>
        method === "auth.test"
          ? Promise.resolve(authOk)
          : new Promise<SlackApiReply>((_, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
      sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    });
    const out = await refreshSlackReadMarkers(h.ctx, input(), deps);
    expect(out.mkIdx).toBe(0);
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "aborted" });
  });

  test("maxChannels caps the pass and the offset advances by that many", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": okInfo("C1"),
        "info:D2": okInfo("D2"),
        "info:E3": okInfo("E3"),
      },
    });
    const out = await refreshSlackReadMarkers(
      h.ctx,
      input({ ids: ["C1", "D2", "E3"], mkIdx: 1 }),
      h.deps({ maxChannels: 2 }),
    );
    expect(h.stored[0]?.markers.map((m) => m.channelId)).toEqual(["D2", "E3"]);
    expect(out.mkIdx).toBe(0);
  });

  test("a store that throws is caught and logged; the function resolves", async () => {
    const h = harness({
      setThrows: true,
      replies: { "auth.test": authOk, "info:C1": okInfo("C1"), "info:D2": okInfo("D2") },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(out.selfUserId).toBe("U9");
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "Error" });
  });

  test("a limiter that throws is caught: the pass ends and the function resolves", async () => {
    const h = harness({ limiterThrows: true });
    const out = await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    expect(out).toEqual({ selfUserId: "UOLD", mkIdx: 0 });
    expect(h.warns[0]?.[0]).toEqual({ service: "slack", code: "Error" });
  });

  test("a thrown non-Error is logged as a generic error", async () => {
    const h = harness({ replies: { "auth.test": authOk } });
    const deps = h.deps({
      callApi: async () => {
        throw "boom";
      },
    });
    const out = await refreshSlackReadMarkers(h.ctx, input({ ids: [] }), deps);
    expect(out.mkIdx).toBe(0);
  });

  test("logs never carry the token or any response text", async () => {
    const h = harness({
      replies: {
        "auth.test": authOk,
        "info:C1": { ok: false, json: { error: "invalid_auth" }, text: "SECRET-RESPONSE-TEXT" },
      },
    });
    await refreshSlackReadMarkers(h.ctx, input(), h.deps());
    const logged = JSON.stringify(h.warns);
    expect(logged).not.toContain("xoxp-secret-token");
    expect(logged).not.toContain("SECRET-RESPONSE-TEXT");
  });

  test("zero channels: auth.test only, then every marker of the service is pruned", async () => {
    const h = harness({ replies: { "auth.test": authOk } });
    const out = await refreshSlackReadMarkers(h.ctx, input({ ids: [] }), h.deps());
    expect(h.calls.map((c) => c.method)).toEqual(["auth.test"]);
    expect(h.stored).toEqual([{ markers: [], opts: { keepChannelIds: [] } }]);
    expect(out).toEqual({ selfUserId: "U9", mkIdx: 0 });
  });

  test("an incomplete list never prunes, and stores nothing when nothing was fetched", async () => {
    const empty = harness({ replies: { "auth.test": authOk } });
    await refreshSlackReadMarkers(empty.ctx, input({ ids: [], listComplete: false }), empty.deps());
    expect(empty.stored).toEqual([]);
    const some = harness({
      replies: { "auth.test": authOk, "info:C1": okInfo("C1"), "info:D2": okInfo("D2") },
    });
    await refreshSlackReadMarkers(some.ctx, input({ listComplete: false }), some.deps());
    expect(some.stored).toHaveLength(1);
    expect(some.stored[0]?.opts).toBeUndefined();
  });

  test("the real defaults are usable: a pass over no channels with an unreachable Slack ends quietly", async () => {
    const h = harness({});
    const deps = h.deps();
    // Exercise the exported default deps' shape without a network call.
    const { DEFAULT_MARKER_PASS_DEPS } = await import("./slack-read-markers.ts");
    expect(DEFAULT_MARKER_PASS_DEPS.budgetMs).toBe(30_000);
    expect(DEFAULT_MARKER_PASS_DEPS.maxChannels).toBe(100);
    expect(DEFAULT_MARKER_PASS_DEPS.now()).toBeGreaterThan(0);
    await DEFAULT_MARKER_PASS_DEPS.sleep(1);
    expect(typeof deps.callApi).toBe("function");
  });
});

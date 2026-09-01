import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  CuActionConsentBroker,
  CuEnvelopeConsentBroker,
} from "../computer-use/cu-consent-broker.ts";
import type { CuGateDeps } from "../computer-use/cu-gate.ts";
import type { BrowserLane, ObservedNode } from "../computer-use/cu-types.ts";
import { DEFAULT_NIMBUS_COMPUTER_USE_TOML } from "../config/nimbus-toml.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type ComputerRpcCtx, dispatchComputerRpc } from "./computer-rpc.ts";

const brokers: Array<CuEnvelopeConsentBroker | CuActionConsentBroker> = [];
// Pending approvals hold live TTL timers; without this, a test that leaves one pending hangs
// `bun test` teardown on Windows.
afterEach(() => {
  for (const b of brokers.splice(0)) b.clear();
});

/**
 * Override BROWSER seams on an existing `gateDeps` without respelling the whole nested `lanes`
 * object. The seams are nested on `CuGateDeps` (one group per lane); these fixtures each differ in
 * one seam, and spreading by hand at every site would bury that one line.
 */
function withBrowserSeams(
  gateDeps: CuGateDeps,
  over: Partial<CuGateDeps["lanes"]["browser"]>,
): CuGateDeps["lanes"] {
  return { ...gateDeps.lanes, browser: { ...gateDeps.lanes.browser, ...over } };
}

function makeCtx(over: Partial<CuGateDeps> = {}): ComputerRpcCtx {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 57);
  const envelopeConsent = new CuEnvelopeConsentBroker();
  const actionConsent = new CuActionConsentBroker();
  brokers.push(envelopeConsent, actionConsent);
  return {
    envelopeConsent,
    actionConsent,
    gateDeps: {
      config: { ...DEFAULT_NIMBUS_COMPUTER_USE_TOML, enabled: true, allowedLanes: ["browser"] },
      enforced: { capabilitiesDisabled: new Set<string>() },
      lanes: {
        browser: {
          resolveBrowserPath: () => null,
          buildLaunchPolicy: ({ profileDir }: { profileDir: string }) => ({
            profileDir: profileDir === "" ? "/fake/profile" : profileDir,
            argv: ["--user-data-dir=/fake/profile"],
          }),
          assertLaunchable: () => null,
          openLane: () => {
            throw new Error("openLane should not be reached in these tests");
          },
        },
        // The terminal seams are REQUIRED on `CuGateDeps` — a gate that could not drive a lane
        // cannot be constructed — so every fixture supplies them even where no test opens one.
        terminal: {
          defaultShellId: "sh",
          resolveShellPath: () => ({
            status: "ok" as const,
            shellPath: "/fake/sh",
            argv: ["-s"],
            envOverlay: {},
          }),
          buildLaunchPolicy: ({
            sessionId,
            shellId,
            shellPath,
            cwd,
          }: {
            sessionId: string;
            shellId: string;
            shellPath: string;
            cwd: string;
          }) => ({
            shellId,
            shellPath,
            argv: ["-s"],
            cwd,
            envOverlay: {},
            policy: {
              id: `cu-terminal-${sessionId}`,
              permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
            },
          }),
          assertLaunchable: () => null,
          openLane: () => {
            throw new Error("the terminal lane is not exercised by this fixture");
          },
        },
      },
      db,
      now: () => 1_700_000_000_000,
      newId: () => "s1",
      requestApproval: (input) =>
        input.promptKind === "action"
          ? actionConsent.request(input, 5_000)
          : envelopeConsent.request(input, 5_000),
      ...over,
    },
  };
}

/** What a working browser lane recorded, for the success-path RPC tests below. */
interface LaneCalls {
  clicks: string[];
  types: { selector: string; text: string }[];
  navigates: string[];
  reads: number;
}

function freshLaneCalls(): LaneCalls {
  return { clicks: [], types: [], navigates: [], reads: 0 };
}

/**
 * A REAL working `BrowserLane` stub -- unlike `makeCtx`'s default `openLane` (which throws), this
 * one actually completes an actuation. `isSubmitControl: true` forces every `click`/`type` to
 * classify `actuating` (cu-classify.ts), so the approval round-trip these tests need to observe is
 * always exercised, mirroring `cu-tools.test.ts`'s own lane stub.
 */
function makeWorkingLane(calls: LaneCalls): BrowserLane {
  const node: ObservedNode = {
    tagName: "BUTTON",
    type: null,
    inFormWithPassword: false,
    inForm: false,
    isSubmitControl: true,
    hrefScheme: null,
    hrefOrigin: null,
    accessibleName: "Submit",
  };
  return {
    observe: async () => node,
    currentOrigin: () => "https://example.com",
    click: async (selector: string) => {
      calls.clicks.push(selector);
    },
    type: async (selector: string, text: string) => {
      calls.types.push({ selector, text });
    },
    navigate: async (url: string) => {
      calls.navigates.push(url);
    },
    readText: async () => {
      calls.reads += 1;
      return "the page text";
    },
    domSnapshot: async () => "<html></html>",
    screenshot: async () => new Uint8Array([1, 2, 3]),
    isAlive: () => true,
    close: async () => {},
  };
}

/**
 * A `ComputerRpcCtx` that can actually OPEN a session and ACT on it -- `makeCtx`'s defaults
 * (`resolveBrowserPath: () => null`, a throwing `openLane`) are deliberately refusal-only, since
 * every pre-existing test in this file only exercised refusal paths. `requestApproval` here
 * resolves directly (bypassing the real broker's TTL/broadcast machinery) so these tests can focus
 * on what crosses the RPC boundary, not on the consent round-trip itself -- that round-trip is
 * already covered by the `computer.approvalRespond` tests below using the real brokers.
 */
function makeLiveCtx(
  calls: LaneCalls,
  approvals: unknown[] = [],
  overGate: Partial<CuGateDeps> = {},
): ComputerRpcCtx {
  const ctx = makeCtx();
  return {
    ...ctx,
    gateDeps: {
      ...ctx.gateDeps,
      lanes: withBrowserSeams(ctx.gateDeps, {
        resolveBrowserPath: () => "/fake/chrome",
        openLane: async () => makeWorkingLane(calls),
      }),
      requestApproval: async (input) => {
        approvals.push(input);
        return true;
      },
      ...overGate,
    },
  };
}

/** Opens a real session against a live ctx and returns its id. */
async function openLiveRpcSession(ctx: ComputerRpcCtx): Promise<string> {
  const out = await dispatchComputerRpc(
    "computer.sessionOpen",
    { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
    ctx,
  );
  if (out.kind !== "hit") throw new Error("unreachable: sessionOpen missed");
  const value = out.value as { status: string; sessionId?: string };
  if (value.status !== "open") throw new Error(`expected status open, got ${value.status}`);
  if (typeof value.sessionId !== "string") throw new Error("expected a sessionId");
  return value.sessionId;
}

describe("computer RPC", () => {
  test("an unknown computer.* method MISSES rather than throwing", async () => {
    const out = await dispatchComputerRpc("computer.nope", {}, makeCtx());
    expect(out.kind).toBe("miss");
  });

  test('computer.sessionOpen requires lane to be exactly "browser"', async () => {
    await expect(
      dispatchComputerRpc("computer.sessionOpen", { lane: "terminal" }, makeCtx()),
    ).rejects.toThrow();
    await expect(dispatchComputerRpc("computer.sessionOpen", {}, makeCtx())).rejects.toThrow();
  });

  test("computer.sessionOpen refuses (no browser) rather than throwing once params are valid", async () => {
    const out = await dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      makeCtx(),
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("refused");
    expect((out.value as { status: string; code?: string }).code).toBe("ERR_CU_NO_BROWSER");
  });

  test("a malformed navigateOrigins array yields an EMPTY list, never a partial one", async () => {
    const ctx = makeCtx();
    let seenReq: unknown;
    const capturingCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: {
        ...ctx.gateDeps,
        lanes: withBrowserSeams(ctx.gateDeps, { resolveBrowserPath: () => "/fake/chrome" }),
        requestApproval: async (input) => {
          seenReq = input;
          return false;
        },
      },
    };
    await dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com", 42], scriptOrigins: [] },
      capturingCtx,
    );
    expect((seenReq as { navigateOrigins: string[] }).navigateOrigins).toEqual([]);
  });

  test("computer.sessionClose requires a sessionId", async () => {
    await expect(dispatchComputerRpc("computer.sessionClose", {}, makeCtx())).rejects.toThrow();
  });

  test("computer.sessionClose reports not_found for an unknown id", async () => {
    const out = await dispatchComputerRpc(
      "computer.sessionClose",
      { sessionId: "nope" },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("not_found");
  });

  test("computer.act rejects an unrecognised kind BEFORE any session work happens", async () => {
    // No session was ever opened. If `kind` were validated AFTER session lookup, the gate itself
    // would throw `ERR_CU_NO_SESSION` (a `CuGateError`, not a `ComputerRpcError`) -- so asserting
    // the specific RPC-layer error class proves the ordering, not merely that SOMETHING threw.
    const { ComputerRpcError } = await import("./computer-rpc.ts");
    let caught: unknown;
    try {
      await dispatchComputerRpc(
        "computer.act",
        { sessionId: "does-not-exist", kind: "explode" },
        makeCtx(),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ComputerRpcError);
  });

  test("computer.act requires a sessionId", async () => {
    await expect(
      dispatchComputerRpc("computer.act", { kind: "click" }, makeCtx()),
    ).rejects.toThrow();
  });

  test("computer.sessionStatus returns an empty list for an unknown session and when the store is empty", async () => {
    const ctx = makeCtx();
    const empty = await dispatchComputerRpc("computer.sessionStatus", {}, ctx);
    if (empty.kind !== "hit") throw new Error("unreachable");
    expect((empty.value as { sessions: unknown[] }).sessions).toEqual([]);

    const missing = await dispatchComputerRpc("computer.sessionStatus", { sessionId: "nope" }, ctx);
    if (missing.kind !== "hit") throw new Error("unreachable");
    expect((missing.value as { sessions: unknown[] }).sessions).toEqual([]);
  });

  test("computer.approvalRespond resolves the pending envelope approval the broker broadcast", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: {
        ...ctx.gateDeps,
        lanes: withBrowserSeams(ctx.gateDeps, { resolveBrowserPath: () => "/fake/chrome" }),
      },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    expect(typeof requestId).toBe("string");

    const resp = await dispatchComputerRpc(
      "computer.approvalRespond",
      { requestId, approved: false },
      ctx,
    );
    if (resp.kind !== "hit") throw new Error("unreachable");
    expect((resp.value as { matched: boolean }).matched).toBe(true);

    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("computer.approvalRespond reports no match for an unknown requestId on either broker", async () => {
    const out = await dispatchComputerRpc(
      "computer.approvalRespond",
      { requestId: "nope", approved: true },
      makeCtx(),
    );
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { matched: boolean }).matched).toBe(false);
  });

  test("approved defaults to FALSE (denial) when the field is absent", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: {
        ...ctx.gateDeps,
        lanes: withBrowserSeams(ctx.gateDeps, { resolveBrowserPath: () => "/fake/chrome" }),
      },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    await dispatchComputerRpc("computer.approvalRespond", { requestId }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  test("approved defaults to FALSE (denial) when the field is a non-boolean truthy value", async () => {
    const ctx = makeCtx();
    const broadcasts: Array<Record<string, unknown>> = [];
    ctx.envelopeConsent.setBroadcast((_m, params) => {
      broadcasts.push(params as Record<string, unknown>);
    });
    const runCtx: ComputerRpcCtx = {
      ...ctx,
      gateDeps: {
        ...ctx.gateDeps,
        lanes: withBrowserSeams(ctx.gateDeps, { resolveBrowserPath: () => "/fake/chrome" }),
      },
    };
    const run = dispatchComputerRpc(
      "computer.sessionOpen",
      { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
      runCtx,
    );
    await Bun.sleep(1);
    const requestId = broadcasts[0]?.["requestId"] as string;
    await dispatchComputerRpc("computer.approvalRespond", { requestId, approved: "yes" }, ctx);
    const out = await run;
    if (out.kind !== "hit") throw new Error("unreachable");
    expect((out.value as { status: string }).status).toBe("denied");
  });

  describe("the success path -- computer.act actually reaching runAction through this transport (pre-push coverage-floor pass)", () => {
    // Every test above this block exercises a REFUSAL: an unknown method, invalid params, "no
    // browser" (resolveBrowserPath returns null), a denied approval. None of them ever calls
    // `computer.act` against a session that is genuinely open with a kind that is genuinely
    // recognised -- so the module's actual write path, and the RunActionRequest construction
    // block that forwards selector/text/url/modelDescription, had zero coverage from this file.

    test("computer.sessionOpen returns status 'open' with a sessionId when everything succeeds -- the OPEN member of the discriminated union, never exercised elsewhere in this file", async () => {
      const ctx = makeLiveCtx(freshLaneCalls());
      const out = await dispatchComputerRpc(
        "computer.sessionOpen",
        { lane: "browser", navigateOrigins: ["https://example.com"], scriptOrigins: [] },
        ctx,
      );
      expect(out.kind).toBe("hit");
      if (out.kind !== "hit") throw new Error("unreachable");
      const value = out.value as { status: string; sessionId?: string };
      expect(value.status).toBe("open");
      expect(typeof value.sessionId).toBe("string");
      expect((value.sessionId ?? "").length).toBeGreaterThan(0);
    });

    test("computer.act with a valid, never-prompting kind ('read') reaches runAction and returns its result verbatim through the RPC boundary", async () => {
      const calls = freshLaneCalls();
      const ctx = makeLiveCtx(calls);
      const sessionId = await openLiveRpcSession(ctx);
      const out = await dispatchComputerRpc("computer.act", { sessionId, kind: "read" }, ctx);
      expect(out.kind).toBe("hit");
      if (out.kind !== "hit") throw new Error("unreachable");
      const value = out.value as { outcome: string; result?: string | null };
      expect(value.outcome).toBe("actuated");
      expect(value.result).toBe("the page text");
      expect(calls.reads).toBe(1);
    });

    test("computer.act forwards selector AND modelDescription from RPC params into RunActionRequest -- observed both on the lane call and in the per-action approval prompt", async () => {
      const calls = freshLaneCalls();
      const approvals: unknown[] = [];
      const ctx = makeLiveCtx(calls, approvals);
      const sessionId = await openLiveRpcSession(ctx);
      const out = await dispatchComputerRpc(
        "computer.act",
        {
          sessionId,
          kind: "click",
          selector: "#submit",
          modelDescription: "clicking the submit button",
        },
        ctx,
      );
      expect(out.kind).toBe("hit");
      if (out.kind !== "hit") throw new Error("unreachable");
      expect((out.value as { outcome: string }).outcome).toBe("actuated");
      // The lane itself received the selector -- proves the RunActionRequest's conditional-spread
      // `selector` field actually made it through, not merely that the call did not throw.
      expect(calls.clicks).toEqual(["#submit"]);
      // `approvals` also holds the earlier envelope-open approval (no `kind` field); pick the
      // per-ACTION one by its `kind` field, not by array position.
      const actionApproval = approvals.find(
        (a): a is { kind: string; modelDescription?: string | null } =>
          typeof a === "object" && a !== null && "kind" in a,
      );
      expect(actionApproval?.kind).toBe("click");
      expect(actionApproval?.modelDescription).toBe("clicking the submit button");
    });

    test("computer.act forwards text (alongside selector) for a 'type' action", async () => {
      const calls = freshLaneCalls();
      const ctx = makeLiveCtx(calls);
      const sessionId = await openLiveRpcSession(ctx);
      const out = await dispatchComputerRpc(
        "computer.act",
        { sessionId, kind: "type", selector: "#field", text: "hello" },
        ctx,
      );
      expect(out.kind).toBe("hit");
      if (out.kind !== "hit") throw new Error("unreachable");
      expect((out.value as { outcome: string }).outcome).toBe("actuated");
      expect(calls.types).toEqual([{ selector: "#field", text: "hello" }]);
    });

    test("computer.act forwards url for a 'navigate' action reaching an in-envelope origin", async () => {
      const calls = freshLaneCalls();
      const ctx = makeLiveCtx(calls);
      const sessionId = await openLiveRpcSession(ctx);
      const out = await dispatchComputerRpc(
        "computer.act",
        { sessionId, kind: "navigate", url: "https://example.com/next" },
        ctx,
      );
      expect(out.kind).toBe("hit");
      if (out.kind !== "hit") throw new Error("unreachable");
      expect((out.value as { outcome: string }).outcome).toBe("actuated");
      expect(calls.navigates).toEqual(["https://example.com/next"]);
    });

    test("computer.act on a sessionId that is NOT live throws (reaches runAction's own ERR_CU_NO_SESSION, distinct from the earlier invalid-kind/missing-sessionId rejections which throw BEFORE runAction)", async () => {
      const ctx = makeLiveCtx(freshLaneCalls());
      // No session was ever opened against this ctx -- "not-a-real-session" is a well-formed,
      // non-empty string with a RECOGNISED kind, so this reaches `runAction` itself rather than
      // being rejected at the RPC-layer validation this file already covers elsewhere.
      await expect(
        dispatchComputerRpc("computer.act", { sessionId: "not-a-real-session", kind: "read" }, ctx),
      ).rejects.toThrow(/no live session/);
    });

    test("computer.sessionOpen forwards maxActions from RPC params into the envelope -- a second action past that budget terminates the session", async () => {
      const calls = freshLaneCalls();
      const ctx = makeLiveCtx(calls);
      const out = await dispatchComputerRpc(
        "computer.sessionOpen",
        {
          lane: "browser",
          navigateOrigins: ["https://example.com"],
          scriptOrigins: [],
          maxActions: 1,
        },
        ctx,
      );
      if (out.kind !== "hit") throw new Error("unreachable");
      const sessionId = (out.value as { sessionId: string }).sessionId;

      const first = await dispatchComputerRpc("computer.act", { sessionId, kind: "read" }, ctx);
      if (first.kind !== "hit") throw new Error("unreachable");
      expect((first.value as { outcome: string }).outcome).toBe("actuated");

      const second = await dispatchComputerRpc("computer.act", { sessionId, kind: "read" }, ctx);
      if (second.kind !== "hit") throw new Error("unreachable");
      expect((second.value as { outcome: string }).outcome).toBe("terminated_budget");
    });
  });
});

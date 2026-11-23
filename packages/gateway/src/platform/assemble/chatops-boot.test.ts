import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Logger } from "pino";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import type {
  ChatopsAgentInvoker,
  ChatopsAgentInvokerDeps,
} from "../../agent-runs/agent-chatops-invoke.ts";
import type { WatcherChatNotifier } from "../../automation/watcher-chat-notifier.ts";
import type { ChatopsBoot } from "../../chatops/chatops-boot.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import { loadOrCreateFederationIdentity } from "../../federation/federation-identity.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { OncallPushRuntime } from "../../oncall-push/push-runtime.ts";
import {
  bindChatopsLocalConsent,
  bootChatopsAgentInvoker,
  settleOncallPushChatops,
  settleWatcherChatops,
} from "./chatops-boot.ts";

describe("settleOncallPushChatops", () => {
  function fakePush(namespace: string) {
    const settled: Array<((text: string) => Promise<number>) | undefined> = [];
    const push = {
      config: { chatopsNamespace: namespace },
      settleChatopsPoster: (p) => {
        settled.push(p);
      },
    } as Pick<OncallPushRuntime, "settleChatopsPoster" | "config">;
    return { push, settled };
  }

  test("with no ChatOps the poster is settled as absent, so held runs are released", () => {
    const { push, settled } = fakePush("payments");
    settleOncallPushChatops(push, undefined);
    expect(settled).toEqual([undefined]);
  });

  test("with ChatOps the poster is bound to the CONFIG namespace, whatever the caller passes", async () => {
    const { push, settled } = fakePush("payments");
    const posts: Array<[string, string]> = [];
    settleOncallPushChatops(push, {
      postPushedBrief: async (namespace, text) => {
        posts.push([namespace, text]);
        return 2;
      },
    });
    expect(settled).toHaveLength(1);
    expect(await settled[0]?.("headline")).toBe(2);
    expect(posts).toEqual([["payments", "headline"]]);
  });
});

describe("settleWatcherChatops (I23)", () => {
  function fakeNotifier(destination: WatcherChatNotifier["destination"]) {
    const settled: Array<((text: string) => Promise<number>) | undefined> = [];
    const notifier = {
      destination,
      settle: (p) => {
        settled.push(p);
      },
    } as Pick<WatcherChatNotifier, "settle" | "destination">;
    return { notifier, settled };
  }
  function fakeBoot() {
    const calls: string[] = [];
    const boot = {
      postWatcherNotice: async (namespace: string, text: string) => {
        calls.push(`ns:${namespace}:${text}`);
        return 1;
      },
      postWatcherNoticePinned: async (text: string) => {
        calls.push(`pinned:${text}`);
        return 3;
      },
    } as Pick<ChatopsBoot, "postWatcherNotice" | "postWatcherNoticePinned">;
    return { boot, calls };
  }

  test("a disabled feature (no notifier) does nothing", () => {
    expect(() => settleWatcherChatops(undefined, fakeBoot().boot)).not.toThrow();
  });

  test("without ChatOps the notifier is settled as absent", () => {
    const { notifier, settled } = fakeNotifier({ kind: "namespace", namespace: "eng" });
    settleWatcherChatops(notifier, undefined);
    expect(settled).toEqual([undefined]);
  });

  test("a namespace destination posts to that namespace only", async () => {
    const { notifier, settled } = fakeNotifier({ kind: "namespace", namespace: "eng" });
    const { boot, calls } = fakeBoot();
    settleWatcherChatops(notifier, boot);
    expect(await settled[0]?.("notice")).toBe(1);
    expect(calls).toEqual(["ns:eng:notice"]);
  });

  test("a pinned destination posts through the pinned seam, which takes no channel", async () => {
    const { notifier, settled } = fakeNotifier({ kind: "pinned" });
    const { boot, calls } = fakeBoot();
    settleWatcherChatops(notifier, boot);
    expect(await settled[0]?.("notice")).toBe(3);
    expect(calls).toEqual(["pinned:notice"]);
  });
});

describe("bootChatopsAgentInvoker", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  function boundInvoker() {
    const bound: ChatopsAgentInvoker[] = [];
    return {
      bound,
      chatopsBoot: { bindAgentInvoker: (fn: ChatopsAgentInvoker) => bound.push(fn) },
    };
  }

  test("without a ChatOps boot nothing is built", () => {
    let built = 0;
    bootChatopsAgentInvoker({
      chatopsBoot: undefined,
      db,
      localIndex: new LocalIndex(db),
      configDir: "c",
      selfIdentity: undefined,
      llmRouter: undefined,
      buildInvoker: () => {
        built += 1;
        return () => Promise.resolve({ ok: false, detail: "x" });
      },
    });
    expect(built).toBe(0);
  });

  test("optional collaborators are omitted, not passed as undefined", () => {
    const { bound, chatopsBoot } = boundInvoker();
    let seen: ChatopsAgentInvokerDeps | undefined;
    bootChatopsAgentInvoker({
      chatopsBoot,
      db,
      localIndex: new LocalIndex(db),
      configDir: "cfg",
      selfIdentity: undefined,
      llmRouter: undefined,
      buildInvoker: (deps) => {
        seen = deps;
        return () => Promise.resolve({ ok: false, detail: "stub" });
      },
    });
    expect(bound).toHaveLength(1);
    expect(seen?.configDir).toBe("cfg");
    expect(seen !== undefined && "selfIdentity" in seen).toBe(false);
    expect(seen !== undefined && "agentLatencyRecorder" in seen).toBe(false);
  });

  test("the identity and the latency recorder are passed when present", async () => {
    const { chatopsBoot } = boundInvoker();
    const identity = await loadOrCreateFederationIdentity(makeInMemoryVault());
    const recorder = { record: () => {} } as unknown as NonNullable<
      Parameters<typeof bootChatopsAgentInvoker>[0]["agentLatencyRecorder"]
    >;
    let seen: ChatopsAgentInvokerDeps | undefined;
    bootChatopsAgentInvoker({
      chatopsBoot,
      db,
      localIndex: new LocalIndex(db),
      configDir: "cfg",
      selfIdentity: identity,
      llmRouter: undefined,
      agentLatencyRecorder: recorder,
      buildInvoker: (deps) => {
        seen = deps;
        return () => Promise.resolve({ ok: false, detail: "stub" });
      },
    });
    expect(seen?.selfIdentity).toBe(identity);
    expect(seen?.agentLatencyRecorder).toBe(recorder);
  });

  test("the default builder yields a real invoker that refuses an unknown agent", async () => {
    const { bound, chatopsBoot } = boundInvoker();
    bootChatopsAgentInvoker({
      chatopsBoot,
      db,
      localIndex: new LocalIndex(db),
      configDir: "cfg",
      selfIdentity: undefined,
      llmRouter: undefined,
    });
    expect(bound).toHaveLength(1);
    const r = await bound[0]?.("no-such-agent", {});
    expect(r).toEqual({ ok: false, detail: "Unknown or unavailable agent 'no-such-agent'." });
  });
});

describe("bindChatopsLocalConsent (I20 fallback leg)", () => {
  const warnings: Array<{ fields: unknown; msg: unknown }> = [];
  const logger = {
    warn: (fields: unknown, msg: unknown) => warnings.push({ fields, msg }),
  } as unknown as Logger;

  function fakeBoot(start: () => Promise<void>) {
    const consent: Array<
      (prompt: string) => Promise<{ approved: boolean; answerSource?: string }>
    > = [];
    const boot = {
      bindLocalConsent: (fn: (typeof consent)[number]) => consent.push(fn),
      service: { start },
    } as unknown as ChatopsBoot;
    return { boot, consent };
  }

  beforeEach(() => {
    warnings.length = 0;
  });
  afterEach(() => {
    delegatedApprovalBroker.setBroadcast(() => {});
  });

  test("without a ChatOps boot nothing is bound and nothing is broadcast", () => {
    const sent: string[] = [];
    bindChatopsLocalConsent({ broadcast: (m) => sent.push(m) }, undefined, logger);
    delegatedApprovalBroker.request({ prompt: "p" }, 1);
    expect(sent).toEqual([]);
  });

  test("the bot is started with the gateway, and a failed start is logged, not thrown", async () => {
    const { boot } = fakeBoot(() => Promise.reject(new Error("no bot tokens")));
    bindChatopsLocalConsent({ broadcast: () => {} }, boot, logger);
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.fields).toEqual({ err: "no bot tokens" });
    expect(String(warnings[0]?.msg)).toContain("nimbus chatops start");
  });

  test("a non-Error start failure is logged as its string form", async () => {
    const { boot } = fakeBoot(() => Promise.reject("plain"));
    bindChatopsLocalConsent({ broadcast: () => {} }, boot, logger);
    await new Promise((r) => setTimeout(r, 10));
    expect(warnings[0]?.fields).toEqual({ err: "plain" });
  });

  test("the owner's answer through the broker approves, recorded as a remote answer", async () => {
    const broadcasts: Array<{ method: string; params: Record<string, unknown> }> = [];
    const { boot, consent } = fakeBoot(() => Promise.resolve());
    bindChatopsLocalConsent(
      { broadcast: (method, params) => broadcasts.push({ method, params: params ?? {} }) },
      boot,
      logger,
    );
    const answer = consent[0]?.("Approve the thing?");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.method).toBe("federation.approvalRequest");
    expect(broadcasts[0]?.params["prompt"]).toBe("Approve the thing?");
    const requestId = String(broadcasts[0]?.params["requestId"]);
    expect(delegatedApprovalBroker.respond(requestId, "peer:owner", true)).toBe(true);
    expect(await answer).toEqual({ approved: true, answerSource: "remote" });
  });

  test("a denial through the broker stays a denial", async () => {
    const broadcasts: Array<Record<string, unknown>> = [];
    const { boot, consent } = fakeBoot(() => Promise.resolve());
    bindChatopsLocalConsent(
      { broadcast: (_m, params) => broadcasts.push(params ?? {}) },
      boot,
      logger,
    );
    const answer = consent[0]?.("Approve?");
    delegatedApprovalBroker.respond(String(broadcasts[0]?.["requestId"]), "peer:owner", false);
    expect(await answer).toEqual({ approved: false, answerSource: "remote" });
  });
});

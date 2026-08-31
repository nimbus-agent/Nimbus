// packages/gateway/src/agent-runs/agent-chatops-invoke.ts

import type { Database } from "bun:sqlite";
import { buildAgentSynthesisRunner } from "../agents/_lib/agent-synthesis-runner.ts";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import type { LocalIndex } from "../index/local-index.ts";
import {
  AgentsRpcError,
  dispatchAgentsRpc,
  resolveExternalAgentMethod,
} from "../ipc/agents-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { requireRunId } from "./agent-http-invoke.ts";

/**
 * 60 s, matching the MCP surface rather than the CLI's 30 s: four of the eleven externally-exposed
 * agents wait on peers -- `ghost`, `conflicts`, `huddle`, `janitor` (`federatedAgentBase`'s five
 * callers in `ipc/agents-rpc.ts`, minus `preflight`, which is excluded from every external surface --
 * see `EXTERNAL_EXCLUDED_AGENT_METHODS`).
 */
export const CHATOPS_AGENT_TIMEOUT_MS = 60_000;

export type ChatopsAgentResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly detail: string };

export type ChatopsAgentInvoker = (agent: string, params: unknown) => Promise<ChatopsAgentResult>;

export type ChatopsAgentInvokerDeps = {
  readonly db: Database;
  readonly index?: LocalIndex;
  readonly configDir?: string;
  readonly selfIdentity?: BoxKeypair;
  /** Required -- not optional -- so a boot path cannot omit it and go silently inert. Pass
   *  `undefined` explicitly for "no synthesis", same as `[agents].synthesis = "off"`. */
  readonly router: SynthesisRouter | undefined;
  readonly timeoutMs?: number;
};

/**
 * A caller-supplied notification payload's `sessionId`, or null when it is absent, non-string, or
 * empty. Exported so the branches below are exercised directly, matching `agent-http-invoke.ts`'s
 * `requireRunId` precedent: defensive code no test can reach is indistinguishable from defensive
 * code that does not work.
 */
export function readSessionId(v: unknown): string | null {
  if (v === null || typeof v !== "object") return null;
  const s = (v as { sessionId?: unknown }).sessionId;
  return typeof s === "string" && s !== "" ? s : null;
}

/** A `<agent>.briefReady` payload's `brief` field, or null when it is absent or not a string. */
export function readBrief(p: unknown): string | null {
  if (p === null || typeof p !== "object") return null;
  const b = (p as { brief?: unknown }).brief;
  return typeof b === "string" ? b : null;
}

/**
 * A `<agent>.briefError` payload's `error` field -- `emit-brief.ts`'s `emitBriefWithSynthesis` always
 * sends one, `err instanceof Error ? err.message : String(err)` -- or null when it is absent or not a
 * string, so a caller can supply its own fallback rather than inventing a message shape here.
 */
export function readErrorMessage(p: unknown): string | null {
  if (p === null || typeof p !== "object") return null;
  const e = (p as { error?: unknown }).error;
  return typeof e === "string" ? e : null;
}

export type AgentNotificationOutcome =
  | { readonly kind: "ready"; readonly markdown: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ignore" };

/**
 * Pure classification of one `ctx.notify(method, params)` call against the session this invocation
 * is waiting on. Exported and pure so every branch -- a session mismatch, a well-formed and a
 * malformed `briefReady`/`briefError`, an unrelated method, and the "session not yet known" state
 * (`expected === null`) -- is a direct unit test rather than something only a real, timing-dependent
 * agent dispatch could exercise.
 *
 * `expected === null` is the "not yet decided" state ONLY while a request is still buffering
 * (`buildChatopsAgentInvoker`'s `expectedKnown` gate below never lets a live call through with
 * `expected` unset) -- see I5: once a session id has been resolved at all, `requireRunId` refuses a
 * missing one rather than leaving `expected` as `null`, so in practice this function is never asked
 * to decide against a `null` `expected` for a LIVE call, only ever for a buffered one about to be
 * replayed through the real value. Kept as a real branch here -- rather than asserted away -- because
 * a future caller of this exported function has no such guarantee.
 */
export function classifyAgentNotification(
  method: string,
  params: unknown,
  expected: string | null,
): AgentNotificationOutcome {
  if (expected !== null && readSessionId(params) !== expected) return { kind: "ignore" };
  if (method.endsWith(".briefReady")) {
    const markdown = readBrief(params);
    return markdown === null ? { kind: "ignore" } : { kind: "ready", markdown };
  }
  if (method.endsWith(".briefError")) {
    const message = readErrorMessage(params) ?? "the agent reported an error";
    return { kind: "error", message };
  }
  return { kind: "ignore" };
}

/**
 * The ChatOps entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never an `agents/<name>.ts` emitter (D22(d)). Builds
 * its runner with the SAME `buildAgentSynthesisRunner` the socket and HTTP paths use, so a channel
 * brief and a CLI brief are the same answer to the same question under every `[agents].synthesis`
 * mode -- by construction, not by both callers happening to omit the field.
 *
 * Unlike the HTTP invoker there is no `AgentRunController`: a channel has no polling client, it has
 * a reply. `notify` resolves a one-shot promise keyed on the dispatch's own `sessionId`.
 *
 * The deadline is armed BEFORE `dispatchAgentsRpc` is even called, so a dispatch that itself hangs
 * (or never resolves -- `dispatchByMethod` calling into a peer-fanning agent, say) is bounded by the
 * SAME timeout as the wait for the resulting brief, not left unbounded ahead of it.
 *
 * A notification can arrive before dispatch has told us the run's real `sessionId` and is BUFFERED,
 * never accepted unfiltered. The reason is NOT that `ctx.notify` is a sink shared across concurrent
 * runs -- unlike `AgentRunController.observe`, this is a fresh closure built fresh per invocation and
 * handed to exactly one `dispatchAgentsRpc` call, so a truly different run's brief cannot reach it.
 * The real hazard is a same-invocation microtask race: `emit-brief.ts`'s `emitBriefWithSynthesis`
 * starts building the brief in a detached, un-awaited async IIFE and returns `{sessionId}`
 * immediately, so THIS session's own `.briefReady` can be scheduled and fire before the `await
 * dispatchAgentsRpc(...)` line below has itself resolved and assigned `expected` -- accepting it
 * while the filter is a no-op (as an earlier draft did) would not be wrong for this session, but it
 * would leave the filter disabled for whatever arrives next, which is the shape of bug this file
 * cannot afford to reintroduce even if today's call graph never routes two sessions through one
 * `notify`. Buffered entries are replayed through the real filter the moment `expected` is set,
 * whether dispatch reports a genuine session or fails outright (see I5 below -- `requireRunId` never
 * lets `expected` end up `null` on a live request). A `settled` guard additionally drops any
 * notification -- buffered or live -- arrived after the deadline already fired, so a late reply can
 * never resurrect a request this function has already returned an answer for.
 *
 * I5: the session id is resolved via the SAME `requireRunId` the HTTP invoker uses, not by
 * tolerating a `null` and leaving the mismatch filter a permanent no-op -- a `miss` or a
 * sessionId-less hit refuses the request instead of silently accepting every notification that
 * follows.
 *
 * No `egress_ledger` append happens here, and that is deliberate: PR 1's post appender ledgers the
 * brief where it actually leaves the machine. See `egress-bearing-kinds.ts`'s `chatops: null`.
 */
export function buildChatopsAgentInvoker(deps: ChatopsAgentInvokerDeps): ChatopsAgentInvoker {
  const timeoutMs = deps.timeoutMs ?? CHATOPS_AGENT_TIMEOUT_MS;

  return async (agent, params): Promise<ChatopsAgentResult> => {
    const method = resolveExternalAgentMethod(agent);
    if (method === null) return { ok: false, detail: `Unknown or unavailable agent '${agent}'.` };

    let resolveBrief: (m: string) => void = () => {};
    let rejectBrief: (e: Error) => void = () => {};
    const briefPromise = new Promise<string>((res, rej) => {
      resolveBrief = res;
      rejectBrief = rej;
    });
    let expected: string | null = null;
    let expectedKnown = false; // true once the dispatch has told us the run's real session id
    let settled = false; // true once the race is over; guards a late/buffered notify from mattering
    const buffered: { method: string; params: unknown }[] = [];

    const runner = buildAgentSynthesisRunner({
      configDir: deps.configDir,
      db: deps.db,
      router: deps.router,
      method,
    });

    const applyNotification = (m: string, p: unknown): void => {
      if (settled) return;
      const outcome = classifyAgentNotification(m, p, expected);
      if (outcome.kind === "ready") resolveBrief(outcome.markdown);
      else if (outcome.kind === "error") rejectBrief(new Error(outcome.message));
    };

    const handleNotification = (m: string, p: unknown): void => {
      if (settled) return;
      if (!expectedKnown) {
        buffered.push({ method: m, params: p });
        return;
      }
      applyNotification(m, p);
    };

    // The deadline timer starts here, BEFORE `dispatchAgentsRpc` is called below -- see the doc
    // comment above. It covers dispatch itself, not just the subsequent wait for `briefPromise`.
    let rejectDeadline: (e: Error) => void = () => {};
    const deadline = new Promise<never>((_, rej) => {
      rejectDeadline = rej;
    });
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      settled = true;
      rejectDeadline(new Error("timed out"));
    }, timeoutMs);

    const work = (async (): Promise<string> => {
      const out = await dispatchAgentsRpc(method, params, {
        db: deps.db,
        notify: handleNotification,
        ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
        ...(deps.index === undefined ? {} : { index: deps.index }),
        ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
        ...(runner === undefined ? {} : { runner }),
        // Server-derived. `chatops` is not in `RECOGNISED`, so no socket client can claim it.
        caller: { clientId: "chatops", kind: "chatops" },
      });
      // I5: refuse rather than accept-anything. A `miss` or a sessionId-less hit throws here
      // (unreachable in production -- see `requireRunId`'s own doc comment -- but a real refusal,
      // not a silently-disabled filter, if that invariant ever breaks).
      expected = requireRunId(agent, out);
      expectedKnown = true;
      // Replay anything that arrived before `expected` was known, now correctly filtered.
      for (const { method: m, params: p } of buffered.splice(0)) applyNotification(m, p);
      return briefPromise;
    })();

    try {
      const markdown = await Promise.race([work, deadline]);
      return { ok: true, markdown };
    } catch (e) {
      if (e instanceof AgentsRpcError) return { ok: false, detail: e.message };
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      settled = true;
      clearTimeout(timer);
    }
  };
}

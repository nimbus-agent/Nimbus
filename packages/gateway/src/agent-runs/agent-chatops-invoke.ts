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

/** 60 s, matching the MCP surface rather than the CLI's 30 s: three of the eleven wait on peers. */
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
  /** Required — not optional — so a boot path cannot omit it and go silently inert. Pass
   *  `undefined` explicitly for "no synthesis", same as `[agents].synthesis = "off"`. */
  readonly router: SynthesisRouter | undefined;
  readonly timeoutMs?: number;
};

function readSessionId(v: unknown): string | null {
  if (v === null || typeof v !== "object") return null;
  const s = (v as { sessionId?: unknown }).sessionId;
  return typeof s === "string" && s !== "" ? s : null;
}

function readBrief(p: unknown): string | null {
  if (p === null || typeof p !== "object") return null;
  const b = (p as { brief?: unknown }).brief;
  return typeof b === "string" ? b : null;
}

/**
 * The ChatOps entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never an `agents/<name>.ts` emitter (D22(d)). Builds
 * its runner with the SAME `buildAgentSynthesisRunner` the socket and HTTP paths use, so a channel
 * brief and a CLI brief are the same answer to the same question under every `[agents].synthesis`
 * mode — by construction, not by both callers happening to omit the field.
 *
 * Unlike the HTTP invoker there is no `AgentRunController`: a channel has no polling client, it has
 * a reply. `notify` resolves a one-shot promise keyed on the dispatch's own `sessionId`.
 *
 * The deadline is armed BEFORE `dispatchAgentsRpc` is even called, so a dispatch that itself hangs
 * (or never resolves — `dispatchByMethod` calling into a peer-fanning agent, say) is bounded by the
 * SAME timeout as the wait for the resulting brief, not left unbounded ahead of it. A notification
 * that arrives before dispatch has told us the run's real `sessionId` is BUFFERED, never accepted
 * unfiltered — `ctx.notify` is the same shared sink `AgentRunController.observe` documents itself
 * as reusing "for unrelated notifications", so a notification for a DIFFERENT concurrent run can
 * reach this closure before `expected` is known; accepting it while the filter is a no-op (as an
 * earlier draft did) could resolve this request with another run's private brief. Buffered entries
 * are replayed through the real filter the moment `expected` is set, whether dispatch reports a
 * genuine session or a `miss` (in which case they are filtered exactly as a live notification would
 * be from that point on — this function does not change what `expected === null` means, only WHEN
 * that meaning starts applying). A `settled` guard additionally drops any notification — buffered
 * or live — arrived after the deadline already fired, so a late reply can never resurrect a request
 * this function has already returned an answer for.
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
    let expectedKnown = false; // distinct from `expected === null` — "null" is a real, decided value
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
      if (expected !== null && readSessionId(p) !== expected) return;
      if (m.endsWith(".briefReady")) {
        const b = readBrief(p);
        if (b !== null) resolveBrief(b);
      } else if (m.endsWith(".briefError")) {
        rejectBrief(new Error("the agent reported an error"));
      }
    };

    const handleNotification = (m: string, p: unknown): void => {
      if (settled) return;
      if (!expectedKnown) {
        buffered.push({ method: m, params: p });
        return;
      }
      applyNotification(m, p);
    };

    // The deadline timer starts here, BEFORE `dispatchAgentsRpc` is called below — see the doc
    // comment above. It covers dispatch itself, not just the subsequent wait for `briefPromise`.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        settled = true;
        rej(new Error("timed out"));
      }, timeoutMs);
    });

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
      expected = out.kind === "hit" ? readSessionId(out.value) : null;
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
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

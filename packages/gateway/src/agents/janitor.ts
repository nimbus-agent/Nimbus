import type { Database } from "bun:sqlite";
import { fanOutProbe } from "../federation/peer-fanout.ts";
import { describeInvalidResourceRef } from "../federation/resource-probe.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps } from "./_lib/fanout-deps.ts";
import type { GapNote, JanitorBrief } from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

export type JanitorInput = {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
};

export type JanitorContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export async function runJanitor(input: JanitorInput, ctx: JanitorContext): Promise<JanitorBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const refProblem = describeInvalidResourceRef(input.resourceRef);
  const refValid = refProblem === null;
  if (refProblem !== null) {
    gaps.push({
      category: "missing_connector",
      detail: refProblem,
    });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no paired peers — run `nimbus team pair`",
    });
  }

  const probe = refValid
    ? await fanOutProbe(buildFanoutDeps(ctx), {
        resourceRef: input.resourceRef,
        purpose: "janitor",
      })
    : { perPeer: [], gaps: [] as GapNote[] };
  gaps.push(...probe.gaps);

  // A peer is "touched" only if it answered touched AND within the idle window. Unknown recency
  // (lastSeenDaysAgo === null) is treated conservatively as inside the window (still in use).
  const touched = probe.perPeer.filter(
    (p) => p.touched && (p.lastSeenDaysAgo === null || p.lastSeenDaysAgo < input.idleDays),
  );
  const peersClear = probe.perPeer.length - touched.length;
  const coverageComplete = gaps.length === 0;
  const noneTouched = touched.length === 0;
  // Withhold when no peer is actively using it BUT coverage is incomplete (a peer gapped /
  // unreachable / the ref was malformed) — unless the owner opted into --allow-gaps.
  const proposalSuppressed = noneTouched && !coverageComplete && !input.allowGaps;
  // Propose only with positive evidence: ≥1 peer affirmatively reported clear, none touched within
  // the window, and either coverage is complete or gaps were explicitly allowed.
  const idle = noneTouched && peersClear > 0 && (coverageComplete || input.allowGaps);

  return {
    kind: "janitor",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { resourceRef: input.resourceRef, idleDays: input.idleDays },
    idle,
    proposalSuppressed,
    cleanupAction: input.cleanupAction,
    peersClear,
    peersTouched: touched.map((p) => ({
      peerId: p.peerId,
      who: p.displayName,
      lastSeenDaysAgo: p.lastSeenDaysAgo,
    })),
  };
}

export function emitJanitorBrief(
  input: JanitorInput,
  ctx: JanitorContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "janitor.briefReady",
    briefErrorMethod: "janitor.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runJanitor(input, ctx),
  });
}

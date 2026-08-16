import type { Database } from "bun:sqlite";
import { fanOutPreflight } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps } from "./_lib/fanout-deps.ts";
import type { GapNote, PreflightBrief } from "./_lib/findings.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

export type PreflightInput = { ref: string; namespace: string; changedSurface: string[] };

export type PreflightContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

export async function runPreflight(
  input: PreflightInput,
  ctx: PreflightContext,
): Promise<PreflightBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no paired peers — run `nimbus team pair`",
    });
  }
  const out = await fanOutPreflight(buildFanoutDeps(ctx), {
    namespace: input.namespace,
    ref: input.ref,
    changedSurface: input.changedSurface,
    purpose: "preflight",
  });
  gaps.push(...out.gaps);
  const downstreams = out.perPeer.map((p) => ({
    peerId: p.peerId,
    who: p.displayName,
    status: p.status,
    summary: p.summary,
  }));
  const anyFailed = downstreams.some((d) => d.status === "fail");
  const anyIncomplete =
    gaps.length > 0 ||
    downstreams.some((d) => d.status === "declined" || d.status === "not_configured");

  return {
    kind: "preflight",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { ref: input.ref, namespace: input.namespace },
    downstreams,
    anyFailed,
    anyIncomplete,
  };
}

export function emitPreflightBrief(
  input: PreflightInput,
  ctx: PreflightContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "preflight.briefReady",
    briefErrorMethod: "preflight.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runPreflight(input, ctx),
  });
}

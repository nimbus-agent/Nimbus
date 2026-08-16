import type { Database } from "bun:sqlite";
import {
  fanOutExpertise,
  fanOutQuery,
  type PeerExpertiseResult,
} from "../federation/peer-fanout.ts";
import type { ExpertiseRank, FederatedItem } from "../federation/types.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps, pushFederationReachGaps } from "./_lib/fanout-deps.ts";
import type { GapNote, GhostBrief, GhostFinding } from "./_lib/findings.ts";
import { resolveMatchToken, symbolExistsLocally } from "./_lib/match-token.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

const GHOST_TYPES = ["pr", "issue", "incident", "commit"] as const;

export type GhostInput = { file: string; namespaces: string[] };

export type GhostContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function rankWeight(rank: ExpertiseRank): number {
  // defensive: "none" is filtered earlier in the findings loop
  if (rank === "none") return 0;
  if (rank === "high") return 3;
  if (rank === "medium") return 2;
  return 1; // "low"
}

export async function runGhost(input: GhostInput, ctx: GhostContext): Promise<GhostBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const resolved = resolveMatchToken(ctx.db, input.file);

  pushFederationReachGaps(gaps, {
    namespaceCount: input.namespaces.length,
    peerCount: ctx.index.listLanPeers().length,
  });

  const deps = buildFanoutDeps(ctx);

  const exp = await fanOutExpertise(deps, { query: resolved.token, purpose: "ghost" });
  gaps.push(...exp.gaps);
  const rankByPeer = new Map<string, PeerExpertiseResult>();
  for (const r of exp.perPeer) rankByPeer.set(r.peerId, r);

  const ctxByPeer = new Map<string, FederatedItem[]>();
  const queryResults = await Promise.all(
    input.namespaces.map((ns) =>
      fanOutQuery(deps, { namespace: ns, purpose: "ghost", types: [...GHOST_TYPES] }),
    ),
  );
  for (const q of queryResults) {
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      const matched = peer.items.filter(
        (it) => it.title.includes(resolved.token) || it.snippet.includes(resolved.token),
      );
      if (matched.length === 0) continue;
      const acc = ctxByPeer.get(peer.peerId) ?? [];
      acc.push(...matched);
      ctxByPeer.set(peer.peerId, acc);
    }
  }

  const symbolExists = symbolExistsLocally(ctx.db, resolved.token);
  const findings: GhostFinding[] = [];
  for (const [peerId, rankRes] of rankByPeer) {
    if (rankRes.rank === "none") continue;
    const context = (ctxByPeer.get(peerId) ?? [])
      // When the referenced symbol no longer exists locally, drop commit context (a fix against
      // since-rewritten code is noise); PRs/issues/incidents retain discussion value, so keep them.
      .filter((it) => symbolExists || it.type !== "commit")
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((it) => ({
        title: it.title,
        snippet: it.snippet,
        service: it.service,
        modifiedAt: it.modifiedAt,
      }));
    if (context.length === 0) continue;
    const who = rankRes.displayName ?? peerId;
    findings.push({
      peerId,
      expert: rankRes.displayName,
      rank: rankRes.rank,
      context,
      suggestedContact: `Ask ${who} (${rankRes.rank} relevance)`,
    });
  }
  findings.sort((a, b) => rankWeight(b.rank) - rankWeight(a.rank));

  return {
    kind: "ghost",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { file: input.file },
    startEntityId: resolved.entityId,
    findings,
  };
}

export function emitGhostBrief(
  input: GhostInput,
  ctx: GhostContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "ghost.briefReady",
    briefErrorMethod: "ghost.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runGhost(input, ctx),
  });
}

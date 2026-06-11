import type { Database } from "bun:sqlite";
import {
  fanOutExpertise,
  fanOutQuery,
  type PeerExpertiseResult,
} from "../federation/peer-fanout.ts";
import type { FederatedItem } from "../federation/types.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote, GhostBrief, GhostFinding } from "./_lib/findings.ts";
import { resolveMatchToken, symbolExistsLocally } from "./_lib/match-token.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const GHOST_TYPES = ["pr", "issue", "incident", "commit"] as const;

export type GhostInput = { file: string; namespaces: string[] };

export type GhostContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function fanoutDeps(ctx: GhostContext) {
  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: ctx.store };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;
  return deps;
}

function rankWeight(rank: string): number {
  if (rank === "high") return 3;
  if (rank === "medium") return 2;
  if (rank === "low") return 1;
  return 0;
}

export async function runGhost(input: GhostInput, ctx: GhostContext): Promise<GhostBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const resolved = resolveMatchToken(ctx.db, input.file);

  if (input.namespaces.length === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no known namespaces — pass --namespace <name>",
    });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no paired peers — run `nimbus team pair`",
    });
  }

  const deps = fanoutDeps(ctx);

  const exp = await fanOutExpertise(deps, { query: resolved.token, purpose: "ghost" });
  gaps.push(...exp.gaps);
  const rankByPeer = new Map<string, PeerExpertiseResult>();
  for (const r of exp.perPeer) rankByPeer.set(r.peerId, r);

  const ctxByPeer = new Map<string, FederatedItem[]>();
  for (const ns of input.namespaces) {
    const q = await fanOutQuery(deps, { namespace: ns, purpose: "ghost", types: [...GHOST_TYPES] });
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
      .filter((it) => symbolExists || it.type !== "commit")
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((it) => ({
        title: it.title,
        snippet: it.snippet,
        service: it.service,
        modifiedAt: it.modifiedAt,
      }));
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
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runGhost(input, ctx),
  });
}

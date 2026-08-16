import type { Database } from "bun:sqlite";
import { fanOutQuery } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps, pushFederationReachGaps } from "./_lib/fanout-deps.ts";
import type { ConflictBrief, ConflictFinding, ConflictType, GapNote } from "./_lib/findings.ts";
import { resolveMatchToken } from "./_lib/match-token.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

const CONFLICT_TYPES = ["pr", "issue", "commit"] as const;

export type ConflictInput = { file: string; namespaces: string[] };

export type ConflictContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function classify(itemType: string): ConflictType {
  if (itemType === "issue") return "assigned_ticket";
  if (itemType === "commit") return "recent_commit";
  // pr (and any default) -> open_pr. "open_branch" is intentionally NOT in CONFLICT_TYPES
  // (branch items aren't indexed yet); add a case here if it's ever added to the query.
  return "open_pr";
}

export async function runConflicts(
  input: ConflictInput,
  ctx: ConflictContext,
): Promise<ConflictBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const resolved = resolveMatchToken(ctx.db, input.file);

  pushFederationReachGaps(gaps, {
    namespaceCount: input.namespaces.length,
    peerCount: ctx.index.listLanPeers().length,
  });

  const deps = buildFanoutDeps(ctx);

  const collisions: ConflictFinding[] = [];
  const queryResults = await Promise.all(
    input.namespaces.map((ns) =>
      fanOutQuery(deps, { namespace: ns, purpose: "conflicts", types: [...CONFLICT_TYPES] }),
    ),
  );
  for (const q of queryResults) {
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      for (const it of peer.items) {
        if (!it.title.includes(resolved.token) && !it.snippet.includes(resolved.token)) continue;
        collisions.push({
          peerId: peer.peerId,
          who: peer.displayName,
          service: it.service,
          collisionType: classify(it.type),
          title: it.title,
          snippet: it.snippet,
          modifiedAt: it.modifiedAt,
        });
      }
    }
  }
  collisions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return {
    kind: "conflict",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { file: input.file },
    startEntityId: resolved.entityId,
    collisions,
  };
}

export function emitConflictsBrief(
  input: ConflictInput,
  ctx: ConflictContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "conflicts.briefReady",
    briefErrorMethod: "conflicts.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runConflicts(input, ctx),
  });
}

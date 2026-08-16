import type { Database } from "bun:sqlite";
import { fanOutQuery } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import { buildFanoutDeps, pushFederationReachGaps } from "./_lib/fanout-deps.ts";
import type {
  FederatedItemLite,
  GapNote,
  HuddleBrief,
  HuddleContribution,
} from "./_lib/findings.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

const HUDDLE_TYPES = ["pr", "issue", "incident"] as const;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export type HuddleInput = { sinceMs?: number; namespaces: string[] };

export type HuddleContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  /** Injectable clock for deterministic window tests; production omits it (defaults Date.now). */
  now?: () => number;
};

function lite(it: {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
}): FederatedItemLite {
  return { title: it.title, snippet: it.snippet, service: it.service, modifiedAt: it.modifiedAt };
}

/** Classify a peer's items into the contribution buckets, skipping anything older than the cutoff. */
function collectPeerItems(
  contrib: HuddleContribution,
  items: ReadonlyArray<{
    type: string;
    title: string;
    snippet: string;
    service: string;
    modifiedAt: number;
  }>,
  cutoff: number,
): void {
  for (const it of items) {
    if (it.modifiedAt < cutoff) continue;
    if (it.type === "pr") contrib.prs.push(lite(it));
    else if (it.type === "issue") contrib.tickets.push(lite(it));
    else if (it.type === "incident") contrib.incidents.push(lite(it));
  }
}

function aggregateContributions(
  queryResults: Array<Awaited<ReturnType<typeof fanOutQuery>>>,
  cutoff: number,
  gaps: GapNote[],
): HuddleContribution[] {
  const byPeer = new Map<string, HuddleContribution>();
  for (const q of queryResults) {
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      const contrib =
        byPeer.get(peer.peerId) ??
        ({
          peerId: peer.peerId,
          who: peer.displayName,
          prs: [],
          tickets: [],
          incidents: [],
        } satisfies HuddleContribution);
      collectPeerItems(contrib, peer.items, cutoff);
      byPeer.set(peer.peerId, contrib);
    }
  }
  return [...byPeer.values()];
}

export async function runHuddle(input: HuddleInput, ctx: HuddleContext): Promise<HuddleBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const sinceMs = input.sinceMs ?? DEFAULT_SINCE_MS;
  const cutoff = (ctx.now ?? Date.now)() - sinceMs;

  const namespaces =
    input.namespaces.length > 0
      ? input.namespaces
      : [...new Set(ctx.store.list().map((r) => r.namespace))];
  pushFederationReachGaps(gaps, {
    namespaceCount: namespaces.length,
    peerCount: ctx.index.listLanPeers().length,
  });

  const deps = buildFanoutDeps(ctx);

  const queryResults = await Promise.all(
    namespaces.map((ns) =>
      fanOutQuery(deps, { namespace: ns, purpose: "huddle", types: [...HUDDLE_TYPES] }),
    ),
  );
  const contributions = aggregateContributions(queryResults, cutoff, gaps);

  return {
    kind: "huddle",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    contributions: contributions.filter(
      (c) => c.prs.length + c.tickets.length + c.incidents.length > 0,
    ),
  };
}

export function emitHuddleBrief(
  input: HuddleInput,
  ctx: HuddleContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "huddle.briefReady",
    briefErrorMethod: "huddle.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runHuddle(input, ctx),
  });
}

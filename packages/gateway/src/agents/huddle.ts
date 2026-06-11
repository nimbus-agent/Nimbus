import type { Database } from "bun:sqlite";
import { fanOutQuery } from "../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type {
  FederatedItemLite,
  GapNote,
  HuddleBrief,
  HuddleContribution,
} from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const HUDDLE_TYPES = ["pr", "issue", "incident"] as const;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export type HuddleInput = { sinceMs?: number; namespaces: string[] };

export type HuddleContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
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

function fanoutDeps(ctx: HuddleContext) {
  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
    now?: () => number;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: ctx.store };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;
  if (ctx.now !== undefined) deps.now = ctx.now;
  return deps;
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
  if (namespaces.length === 0) {
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

  const byPeer = new Map<string, HuddleContribution>();
  const queryResults = await Promise.all(
    namespaces.map((ns) =>
      fanOutQuery(deps, { namespace: ns, purpose: "huddle", types: [...HUDDLE_TYPES] }),
    ),
  );
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
      for (const it of peer.items) {
        if (it.modifiedAt < cutoff) continue;
        if (it.type === "pr") contrib.prs.push(lite(it));
        else if (it.type === "issue") contrib.tickets.push(lite(it));
        else if (it.type === "incident") contrib.incidents.push(lite(it));
      }
      byPeer.set(peer.peerId, contrib);
    }
  }

  return {
    kind: "huddle",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    contributions: [...byPeer.values()].filter(
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
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runHuddle(input, ctx),
  });
}

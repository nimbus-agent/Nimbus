import type { GapNote } from "../agents/_lib/findings.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
import { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { ExpertiseRank, FederatedItem } from "./types.ts";

const FANOUT_CONCURRENCY = 5;

export interface PeerFanoutDeps {
  readonly index: LocalIndex;
  readonly selfIdentity: BoxKeypair;
  readonly store: KnownNamespaceStore;
  /** DI seam — defaults to the real over-the-wire client; faked in tests. */
  readonly sendOverWire?: typeof sendFederatedOverWire;
  readonly now?: () => number;
}

export interface PeerQueryResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly items: readonly FederatedItem[];
}

export interface PeerExpertiseResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly rank: ExpertiseRank;
}

export interface PeerFanoutOutcome<T> {
  readonly perPeer: readonly T[];
  readonly gaps: readonly GapNote[];
}

function reachablePeers(index: LocalIndex): LanPeerRow[] {
  return index.listLanPeers().filter((r) => r.host_ip !== null && r.host_port !== null);
}

function gapForPeer(row: LanPeerRow, err: unknown): GapNote {
  const who = row.display_name ?? row.peer_id;
  const msg = err instanceof Error ? err.message : String(err);
  return { category: "missing_connector", detail: `peer ${who}: ${msg}` };
}

/** Bounded-parallel map: at most FANOUT_CONCURRENCY in-flight; never rejects (errors map to gaps). */
async function runPool<T>(
  rows: LanPeerRow[],
  worker: (row: LanPeerRow) => Promise<{ ok: T } | { gap: GapNote }>,
): Promise<{ perPeer: T[]; gaps: GapNote[] }> {
  const perPeer: T[] = [];
  const gaps: GapNote[] = [];
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (row === undefined) return;
      const r = await worker(row);
      if ("ok" in r) perPeer.push(r.ok);
      else gaps.push(r.gap);
    }
  }
  const lanes = Math.min(FANOUT_CONCURRENCY, rows.length);
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return { perPeer, gaps };
}

export async function fanOutQuery(
  deps: PeerFanoutDeps,
  req: { namespace: string; purpose: string; types?: readonly string[] },
): Promise<PeerFanoutOutcome<PeerQueryResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const nowMs = (deps.now ?? Date.now)();
  const body: Record<string, unknown> = { namespace: req.namespace, purpose: req.purpose };
  if (req.types !== undefined) body["types"] = [...req.types];

  const { perPeer, gaps } = await runPool<PeerQueryResult>(
    reachablePeers(deps.index),
    async (row) => {
      const who = row.display_name ?? row.peer_id;
      try {
        const result = (await send(
          row.host_ip as string,
          row.host_port as number,
          deps.selfIdentity,
          row.peer_pubkey,
          "federation.query",
          body,
        )) as { kind?: string; response?: { items?: readonly FederatedItem[] }; error?: string };
        if (result.kind === "error") {
          if (result.error === "no_grant") deps.store.prune(row.peer_id, req.namespace);
          return {
            gap: {
              category: "missing_connector",
              detail: `peer ${who}: ${result.error ?? "error"}`,
            },
          };
        }
        deps.store.record(row.peer_id, req.namespace, nowMs);
        return {
          ok: {
            peerId: row.peer_id,
            displayName: row.display_name,
            items: result.response?.items ?? [],
          },
        };
      } catch (err) {
        return { gap: gapForPeer(row, err) };
      }
    },
  );
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}

export async function fanOutExpertise(
  deps: PeerFanoutDeps,
  req: { query: string; purpose: string },
): Promise<PeerFanoutOutcome<PeerExpertiseResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const { perPeer, gaps } = await runPool<PeerExpertiseResult>(
    reachablePeers(deps.index),
    async (row) => {
      try {
        const result = (await send(
          row.host_ip as string,
          row.host_port as number,
          deps.selfIdentity,
          row.peer_pubkey,
          "federation.expertise",
          { query: req.query, purpose: req.purpose },
        )) as { kind?: string; rank?: ExpertiseRank };
        // Defensive: treat a gated/error envelope as rank "none" (consistent with fanOutQuery).
        if ((result as { kind?: string }).kind === "error") {
          return {
            ok: { peerId: row.peer_id, displayName: row.display_name, rank: "none" },
          };
        }
        return {
          ok: { peerId: row.peer_id, displayName: row.display_name, rank: result.rank ?? "none" },
        };
      } catch (err) {
        return { gap: gapForPeer(row, err) };
      }
    },
  );
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}

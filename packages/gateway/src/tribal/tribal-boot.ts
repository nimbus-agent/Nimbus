import type { Database } from "bun:sqlite";
import type { ChatMessage, ReplyTarget } from "../chatops/types.ts";
import type { NimbusTribalToml } from "../config/nimbus-toml.ts";
import type { TribalRpcCtx } from "../ipc/tribal-rpc.ts";
import type { SynthesizedAnswer } from "./answer-synthesizer.ts";
import { type TribalCluster, TribalClusterStore, type TribalStatus } from "./cluster-store.ts";
import type { RecallHit } from "./repeat-detector.ts";
import { postSuggestion } from "./tribal-suggestion.ts";
import { TribalWatcher } from "./tribal-watcher.ts";
import { captureToKnowledgeBase } from "./tribal-write-gate.ts";

const DAY_MS = 86_400_000;
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "suggested",
  "captured",
  "dismissed",
]);

export interface TribalBootDeps {
  readonly db: Database;
  readonly cfg: NimbusTribalToml;
  /** Local MiniLM (or routed) query embedder — 384-dim, no network. */
  readonly embedQuery: (text: string) => Promise<Float32Array | null>;
  /**
   * The bot's own platform user/app ids — the watcher skips them to avoid a suggestion→ingest
   * feedback loop (review §1.1). Defense-in-depth atop the Slack normalizer's bot_id/subtype skip.
   */
  readonly botUserIds: ReadonlySet<string>;
  /**
   * The I23 reply seam (chatops reply-dispatcher `send`). Suggestions post through it to the
   * originating channel. May be a no-op when chatops is disabled (detection still records clusters).
   */
  readonly send: (target: ReplyTarget, text: string) => Promise<void>;
  /**
   * I25 capture seam. When present, `tribal.capture` is live: a draft is synthesized and submitted
   * through the executor HITL gate (the `submitAction` is supplied PER-CALL by the dispatcher with
   * the initiating client's consent), writing to the config-pinned KB. Absent → `capture_unavailable`
   * (detection/suggestion still work). The destination is resolved from `cfg.notion`/`cfg.confluence`
   * only — never from the caller (the write-gate enforces this).
   */
  readonly synthesize?: (cluster: TribalCluster) => Promise<SynthesizedAnswer>;
  readonly log?: (m: string) => void;
  readonly now?: () => number;
}

export interface TribalBoot {
  /** Fan-out target wired into `buildChatopsBoot({ onInboundMessage })`. Never throws. */
  readonly onInboundMessage: (m: ChatMessage) => Promise<void>;
  readonly rpcCtx: TribalRpcCtx;
}

/** 1 − cosine similarity; 0 = identical direction, 2 = opposite. Mirrors the detector's distance. */
function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Assembles the tribal-knowledge subsystem: an inbound-message watcher (detection + I23 suggestion)
 * plus the `tribal.*` RPC context. Fail-closed: an enabled watcher with no `watch_channels`
 * allowlist throws (review §1.1) — the privacy boundary must be explicit, never empty-means-all.
 *
 * `recall` scans the cluster ledger's stored representative vectors for the nearest existing cluster
 * (the near-dup-merge primitive), restricted to watched channels — the cluster ledger, not the raw
 * message corpus, is what the detector merges into.
 */
export function buildTribalBoot(deps: TribalBootDeps): TribalBoot {
  if (deps.cfg.watchChannels.length === 0) {
    throw new Error(
      "[tribal].enabled requires a non-empty watch_channels allowlist (fail-closed; review §1.1)",
    );
  }
  const store = new TribalClusterStore(deps.db);
  const watchChannels = new Set(deps.cfg.watchChannels);
  const now = deps.now ?? ((): number => Date.now());
  const cooldownMs = deps.cfg.cooldownDays * DAY_MS;

  const recall = (vec: Float32Array): RecallHit[] => {
    const hits: RecallHit[] = [];
    for (const c of store.listWithVec()) {
      if (!watchChannels.has(c.channelId) || c.representativeVec === null) continue;
      hits.push({
        clusterId: c.clusterId,
        channelId: c.channelId,
        distance: cosineDistance(vec, c.representativeVec),
      });
    }
    return hits;
  };

  const watcher = new TribalWatcher({
    db: deps.db,
    embed: deps.embedQuery,
    recall,
    send: deps.send,
    watchChannels,
    botUserIds: deps.botUserIds,
    minOccurrences: deps.cfg.minOccurrences,
    windowDays: deps.cfg.windowDays,
    matchMode: deps.cfg.match,
    now,
    ...(deps.log === undefined ? {} : { log: deps.log }),
  });

  let running = true;

  const rpcCtx: TribalRpcCtx = {
    status: () => ({ enabled: running, clusters: store.count() }),
    start: async () => {
      running = true;
    },
    stop: async () => {
      running = false;
    },
    list: (status) => {
      if (status === undefined || status === "") return store.listAll();
      if (!VALID_STATUSES.has(status)) {
        throw new Error(`ERR_INVALID_PARAMS: unknown status ${status}`);
      }
      return store.listByStatus(status as TribalStatus);
    },
    dismiss: async (clusterId) => {
      store.markDismissed(clusterId, { now: now(), cooldownUntil: now() + cooldownMs });
    },
    scan: async () => {
      // Re-evaluate pending clusters that crossed the threshold but were never suggested (e.g. the
      // suggestion post failed). Fires a suggestion for each qualifying cluster.
      const windowMs = deps.cfg.windowDays * DAY_MS;
      const pending = store.listByStatus("pending");
      let fired = 0;
      for (const c of pending) {
        const inWindow = c.lastSeen - c.firstSeen <= windowMs;
        if (c.occurrenceCount >= deps.cfg.minOccurrences && inWindow) {
          try {
            await postSuggestion({ send: deps.send, store, now }, c);
            fired++;
          } catch (err) {
            deps.log?.(
              `tribal scan suggestion error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
      return { scanned: pending.length, fired };
    },
    capture: async (clusterId, target, submitAction) => {
      if (deps.synthesize === undefined) {
        return { ok: false, error: "capture_unavailable" };
      }
      const cluster = store.get(clusterId);
      if (cluster === undefined) return { ok: false, error: "not_found" };
      const t = target === "notion" || target === "confluence" ? target : undefined;
      const r = await captureToKnowledgeBase(
        {
          cfg: {
            ...(deps.cfg.notion === undefined ? {} : { notion: deps.cfg.notion }),
            ...(deps.cfg.confluence === undefined ? {} : { confluence: deps.cfg.confluence }),
          },
          synthesize: deps.synthesize,
          submitAction,
          store,
          cooldownDays: deps.cfg.cooldownDays,
          now,
        },
        cluster,
        t,
      );
      return r.ok ? { ok: true, pageRef: r.pageRef } : { ok: false, error: r.error };
    },
  };

  const onInboundMessage = (m: ChatMessage): Promise<void> =>
    running ? watcher.ingest(m) : Promise.resolve();

  return { onInboundMessage, rpcCtx };
}

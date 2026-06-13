import { createHash } from "node:crypto";
import type { TribalCluster, TribalClusterStore } from "./cluster-store.ts";

/** A prior similar question surfaced by recall, already mapped to its cluster + channel. */
export interface RecallHit {
  clusterId: string;
  channelId: string;
  distance: number;
}

export interface RepeatDetectorDeps {
  embed: (text: string) => Promise<Float32Array | null>;
  /**
   * Production: vectorSearchChunks over slack/teams `message` items, channel-filtered IN SQL via
   * `json_extract(metadata,'$.channel') IN (watchChannels)` so the top-N are all watched-channel
   * hits (review §2.1 — never push watched hits out of top-N), then map item→cluster.
   */
  recall: (vec: Float32Array) => RecallHit[];
  store: TribalClusterStore;
  watchChannels: ReadonlySet<string>;
  minOccurrences: number;
  windowDays: number;
  matchMode: "embedding" | "embedding+llm";
  similarityThreshold: number;
  /** Optional precision pass; absent in embedding-only mode. Returns true if same intent. */
  llmJudge?: (a: string, b: string) => Promise<boolean>;
  now: () => number;
}

export interface DetectResult {
  fired: boolean;
  cluster?: TribalCluster;
  reason?: "channel_not_watched" | "below_threshold" | "in_cooldown_or_done" | "fired";
}

/** Stable cluster id for a brand-new question (no near match): normalize + hash. */
function newClusterId(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `tq_${createHash("sha256").update(norm).digest("hex").slice(0, 16)}`;
}

/**
 * Pick the cluster id for an incoming question: the nearest existing cluster within threshold
 * (optionally confirmed by the LLM judge), else a fresh id. Behavior-preserving extraction of the
 * near-match resolution branch from {@link detectRepeat} (keeps that function under the complexity gate).
 */
async function resolveClusterId(
  deps: RepeatDetectorDeps,
  text: string,
  nearest: RecallHit | undefined,
): Promise<string> {
  const fresh = newClusterId(text);
  if (nearest === undefined || nearest.distance > 1 - deps.similarityThreshold) return fresh;
  if (deps.matchMode !== "embedding+llm" || deps.llmJudge === undefined) return nearest.clusterId;
  const existing = deps.store.get(nearest.clusterId);
  if (existing === undefined) return nearest.clusterId;
  const same = await deps.llmJudge(existing.representativeQuestion, text);
  return same ? nearest.clusterId : fresh;
}

export async function detectRepeat(
  deps: RepeatDetectorDeps,
  msg: { text: string; channelId: string; platform: string },
): Promise<DetectResult> {
  if (!deps.watchChannels.has(msg.channelId)) {
    return { fired: false, reason: "channel_not_watched" };
  }

  const vec = await deps.embed(msg.text);
  if (vec === null) return { fired: false, reason: "below_threshold" };

  // Nearest existing cluster within threshold (review §2.3) — recall only returns watched-channel hits.
  const hits = deps
    .recall(vec)
    .filter((h) => deps.watchChannels.has(h.channelId))
    .sort((a, b) => a.distance - b.distance);
  const clusterId = await resolveClusterId(deps, msg.text, hits[0]);

  const cluster = deps.store.upsertOccurrence({
    clusterId,
    question: msg.text,
    vec,
    channelId: msg.channelId,
    platform: msg.platform,
    now: deps.now(),
  });

  if (cluster.status === "captured" || cluster.status === "dismissed") {
    return { fired: false, cluster, reason: "in_cooldown_or_done" };
  }
  const windowMs = deps.windowDays * 86_400_000;
  const inWindow = cluster.lastSeen - cluster.firstSeen <= windowMs;
  if (cluster.status === "pending" && cluster.occurrenceCount >= deps.minOccurrences && inWindow) {
    return { fired: true, cluster, reason: "fired" };
  }
  return { fired: false, cluster, reason: "below_threshold" };
}

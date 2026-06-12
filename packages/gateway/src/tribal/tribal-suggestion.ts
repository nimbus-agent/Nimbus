import type { ChatPlatform, ReplyTarget } from "../chatops/types.ts";
import type { TribalCluster, TribalClusterStore } from "./cluster-store.ts";

export interface SuggestionDeps {
  send: (target: ReplyTarget, text: string) => Promise<void>;
  store: TribalClusterStore;
  now: () => number;
}

/**
 * Posts a lightweight repeat-question nudge to the originating channel via the I23
 * reply-dispatcher (NO synthesis — capture is lazy), then marks the cluster `suggested`.
 */
export async function postSuggestion(deps: SuggestionDeps, cluster: TribalCluster): Promise<void> {
  const target: ReplyTarget = {
    kind: "originating",
    platform: cluster.platform as ChatPlatform,
    channelId: cluster.channelId,
  };
  const text =
    `📌 This question has come up ${cluster.occurrenceCount}× — “${cluster.representativeQuestion}”.\n` +
    `Save the answer to the team KB? Run \`nimbus tribal capture ${cluster.clusterId}\` (or \`tribal dismiss ${cluster.clusterId}\`).`;
  await deps.send(target, text);
  deps.store.markSuggested(cluster.clusterId, deps.now());
}

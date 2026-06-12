import type { Database } from "bun:sqlite";
import type { ChatMessage, ReplyTarget } from "../chatops/types.ts";
import { TribalClusterStore } from "./cluster-store.ts";
import { isQuestion } from "./is-question.ts";
import { detectRepeat, type RecallHit } from "./repeat-detector.ts";
import { postSuggestion } from "./tribal-suggestion.ts";

export interface TribalWatcherDeps {
  db: Database;
  embed: (text: string) => Promise<Float32Array | null>;
  recall: (vec: Float32Array) => RecallHit[];
  send: (target: ReplyTarget, text: string) => Promise<void>;
  watchChannels: ReadonlySet<string>;
  /**
   * The bot's own platform user/app ids — messages from these are skipped to prevent a
   * suggestion→ingest feedback loop (review §1.1). Captured at boot (Task 11).
   */
  botUserIds: ReadonlySet<string>;
  minOccurrences: number;
  windowDays: number;
  cooldownDays: number;
  matchMode: "embedding" | "embedding+llm";
  llmJudge?: (a: string, b: string) => Promise<boolean>;
  now: () => number;
  log?: (m: string) => void;
}

export class TribalWatcher {
  private readonly store: TribalClusterStore;
  constructor(private readonly deps: TribalWatcherDeps) {
    this.store = new TribalClusterStore(deps.db);
  }

  /** Fan-out target: called for every watched inbound message. Never throws. */
  async ingest(msg: ChatMessage): Promise<void> {
    try {
      if (this.deps.botUserIds.has(msg.userId)) return; // never ingest our own posts (review §1.1)
      if (!this.deps.watchChannels.has(msg.channelId)) return;
      if (!isQuestion(msg.text)) return;
      const result = await detectRepeat(
        {
          embed: this.deps.embed,
          recall: this.deps.recall,
          store: this.store,
          watchChannels: this.deps.watchChannels,
          minOccurrences: this.deps.minOccurrences,
          windowDays: this.deps.windowDays,
          matchMode: this.deps.matchMode,
          similarityThreshold: 0.85,
          ...(this.deps.llmJudge !== undefined ? { llmJudge: this.deps.llmJudge } : {}),
          now: this.deps.now,
        },
        { text: msg.text, channelId: msg.channelId, platform: msg.platform },
      );
      if (result.fired && result.cluster !== undefined) {
        await postSuggestion(
          { send: this.deps.send, store: this.store, now: this.deps.now },
          result.cluster,
        );
      }
    } catch (err) {
      this.deps.log?.(`tribal ingest error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

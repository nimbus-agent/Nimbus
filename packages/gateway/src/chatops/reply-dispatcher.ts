import type { ChatPlatform, ReplyTarget } from "./types.ts";

export interface ReplyDispatcherDeps {
  /**
   * The ONLY function that actually posts to a connector. Imported/wired ONLY here (D17). For a
   * namespaceNotify target the platform is resolved from the channel binding upstream; this slice
   * posts notify channels on whichever platform the connector tool maps them to (Slack first).
   */
  readonly post: (platform: ChatPlatform, channelId: string, text: string) => Promise<void>;
  /** Policy-declared notify channels for a namespace (from EnforcedPolicy.chatops). */
  readonly notifyChannelsFor: (namespace: string) => readonly string[];
  /**
   * The owner's pinned watcher-notice channel after the org policy's say (0 or 1 id). Supplied ONLY
   * to the watcher-notice dispatcher in `chatops-boot.ts`; every other dispatcher is built without
   * it and refuses a `watcherPinned` target.
   */
  readonly pinnedChannelFor?: () => readonly string[];
}

/**
 * I23 — the sole operational (non-HITL) post path. Destination comes ONLY from a server-derived
 * `ReplyTarget` (the originating message's channel, or a policy `notify` channel for a namespace) —
 * never a caller-supplied raw channel. Arbitrary-destination posting is reachable only via the
 * HITL-gated `*.message.post` action types (I2). No other chatops module may import the connector
 * post tool (enforced statically by D17).
 */
export class ReplyDispatcher {
  constructor(private readonly deps: ReplyDispatcherDeps) {}

  /**
   * Resolves to the number of channels posted to: 1 for `originating`, N for `namespaceNotify` (0
   * when the namespace has no notify channels). Channels are posted in turn and a throw stops the
   * rest, so a caller seeing a rejection must treat delivery as possibly partial.
   */
  async send(target: ReplyTarget, text: string): Promise<number> {
    if (target.kind === "originating") {
      await this.deps.post(target.platform, target.channelId, text);
      return 1;
    }
    if (target.kind === "watcherPinned") {
      const pinned = this.deps.pinnedChannelFor;
      if (pinned === undefined) {
        throw new Error("this reply dispatcher cannot post to the watcher-pinned channel");
      }
      let postedPinned = 0;
      for (const channelId of pinned()) {
        await this.deps.post("slack", channelId, text); // NOSONAR S9382: I23/I29 — the post appends its own egress row first
        postedPinned += 1;
      }
      return postedPinned;
    }
    let posted = 0;
    for (const channelId of this.deps.notifyChannelsFor(target.namespace)) {
      await this.deps.post("slack", channelId, text); // NOSONAR S9382: I23/I29 — each post appends its own egress row first; posts go out in order and a failure stops later channels
      posted += 1;
    }
    return posted;
  }
}

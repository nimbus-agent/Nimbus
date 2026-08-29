import type { Database } from "bun:sqlite";

import { hashChannelId } from "../chatops/channel-salt.ts";
import type { ChatPlatform } from "../chatops/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/** Which consumer is posting. Bound at CONSTRUCTION, never passed per call. */
export type ChatPostKind = "reply" | "approvalCard" | "agentBrief";

export type ChatPost = (platform: ChatPlatform, channelId: string, text: string) => Promise<void>;

const METHOD_FOR: Readonly<Record<ChatPostKind, string>> = Object.freeze({
  reply: "chatops.reply",
  approvalCard: "chatops.approvalCard",
  agentBrief: "chatops.agentBrief",
});

/**
 * The I29 `chatops`-class appender, and the only one.
 *
 * Before this, NO chat post was ledgered: the reply path is
 * `ReplyDispatcher` -> `buildConnectorPost` -> an ephemeral bot-credentialed connector spawn,
 * which never reaches the executor's `connectors.dispatch` chokepoint. The gap was also
 * UNDISCLOSED — I29 named no chatops class — so `nimbus prove` reported zero over windows in which
 * an answer synthesized from the private index was posted to Slack's servers.
 *
 * A DECORATOR at construction, like `wrapLedgeredProvider` / `wrapLedgeredEmbedder`, so it covers
 * every consumer including ones written later without any of them cooperating.
 *
 * ONE FACTORY, N FUNCTIONS, rather than one wrapper. The wrapped signature carries no indication
 * of WHICH consumer is calling, so a single wrapper could not derive `method` without sniffing the
 * text — fragile and wrong. An optional `kind?` argument would fix that by conceding the property:
 * the value would become caller-supplied AND omittable, so a consumer that forgot it would be
 * silently mis-attributed. Binding the kind at the one wiring site that already knows which
 * consumer it is building keeps `method` server-derived. `Record<ChatPostKind, ChatPost>` is total,
 * so a new kind does not compile until it is wired.
 *
 * The caller must pass `buildConnectorPost(...)` DIRECTLY as `raw` and never bind it to a name —
 * an unwrapped `post` in scope is a bypass waiting for the next consumer. D17 enforces this.
 */
export function buildLedgeredChatPosts(
  db: Database,
  raw: ChatPost,
  saltB64: string,
  now: () => number = Date.now,
): Readonly<Record<ChatPostKind, ChatPost>> {
  const wrap = (kind: ChatPostKind): ChatPost => {
    return async (platform, channelId, text): Promise<void> => {
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "chatops",
          // Salted hash, never the id: a channel id names a group of PEOPLE, and this table is
          // append-only with a HITL-gated prune as its only mutation path.
          sourceId: hashChannelId(saltB64, channelId),
          destination: platform,
          method: METHOD_FOR[kind],
          // Byte length only. Never the text — the ledger proves what left, it does not keep a
          // second copy of it.
          payloadSummary: redactEgressSummary({ bytes: Buffer.byteLength(text, "utf8") }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        // Diagnostic context only (never security-relevant): `chatops-boot.ts`'s `handleMessage`
        // catches this at the message seam and logs it at `error` per design §13.1 — naming the
        // kind and the UNHASHED channel id (the log is not the ledger; different retention, and
        // an operator debugging a boot log needs the id, not its hash) without having to guess
        // which of the several posts a message can trigger actually failed.
        throw new EgressAppendFailedError(err, {
          chatopsPostKind: kind,
          chatopsChannelId: channelId,
        });
      }
      await raw(platform, channelId, text);
    };
  };

  return Object.freeze({
    reply: wrap("reply"),
    approvalCard: wrap("approvalCard"),
    agentBrief: wrap("agentBrief"),
  });
}

import type { ChatPlatform } from "./types.ts";

/**
 * Slack's control-character escape for text a bot posts: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
 * in that order. `&` goes first, or the `&` of a `&lt;` this function just wrote would be escaped
 * again. With all three escaped, nothing a caller passes can form a `<!channel>` mention, a `<@U…>`
 * user mention or a `<url|label>` link whose label hides its target. Slack renders the entities as
 * the literal characters, so readers see the original text.
 *
 * Slack-only by design: `ReplyDispatcher` posts every `namespaceNotify` message as `"slack"`
 * (design: 2026-10-02-oncall-push-chatops-design.md § 7), and Teams has a different markup.
 */
export function escapeSlackText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The text exactly as it leaves the machine for `platform`. Every chat post is decorated by
 * `egress/chatops-egress.ts`'s `buildLedgeredChatPosts` (D17 makes it the only post path), which
 * calls this BEFORE appending its ledger row, so the row's byte count is the wire byte count and
 * every consumer — agent briefs, `ask` answers, approval cards, tribal suggestions, the on-call
 * headline — is escaped with no cooperation from its caller. None of them sends Slack markup on
 * purpose, so escaping everything removes nothing intended.
 *
 * Teams is left unchanged: it does not read Slack's `<…>` tokens, and an entity there would render
 * as the literal text `&lt;`.
 */
export function toWireText(platform: ChatPlatform, text: string): string {
  return platform === "slack" ? escapeSlackText(text) : text;
}

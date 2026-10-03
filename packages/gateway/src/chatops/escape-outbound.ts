/**
 * Slack's control-character escape for text a bot posts: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
 * in that order. `&` goes first, or the `&` of a `&lt;` this function just wrote would be escaped
 * again. With all three escaped, nothing a caller passes can form a `<!channel>` mention, a `<@U…>`
 * user mention or a `<url|label>` link whose label hides its target. Slack renders the entities as
 * the literal characters, so readers see the original text.
 *
 * Slack-only by design: `ReplyDispatcher` posts every `namespaceNotify` message as `"slack"`
 * (spec § 7), and Teams has a different markup.
 */
export function escapeSlackText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

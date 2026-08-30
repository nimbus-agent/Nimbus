/**
 * Strip chat-platform decorators before any tokenizing (review S1). Read-only + total: never invents
 * tokens. Handles: leading `@nimbus`/`<@U…>`/`<at>…</at>` mention, Slack link `<url|text>`/`<url>` ->
 * text, `<@U…>`/`<#C…|name>` user/channel refs -> bare form, smart quotes -> ASCII, surrounding
 * backticks, non-breaking spaces, collapsed whitespace.
 */
export function normalizeChatText(raw: string): string {
  let s = raw.replaceAll("\u00A0", " ");
  // smart quotes -> ASCII
  s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // slack link <url|label> -> label ; <url> -> url (classes exclude `<` so backtracking stays
  // linear; Slack escapes a literal `<` as &lt; inside tokens, so nothing real is missed)
  s = s.replace(/<([^<|>]+)\|([^<>]+)>/g, "$2").replace(/<(https?:[^<>]+)>/g, "$1");
  // user/channel mention tokens -> drop the wrapping; <#C123|name> -> name, <@U123> -> ""
  s = s.replace(/<#[^<|>]+\|([^<>]+)>/g, "$1").replace(/<@[^<>]+>/g, "");
  // leading bot mention
  s = s.replace(/^\s*(?:@nimbus|<at>\s*nimbus\s*<\/at>)\s*/i, "");
  // strip backticks (inline code / fences)
  s = s.replaceAll("```", "").replaceAll("`", "");
  return s.replace(/\s+/g, " ").trim();
}

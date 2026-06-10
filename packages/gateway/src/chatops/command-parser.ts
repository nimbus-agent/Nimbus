import type { ParsedCommand } from "./types.ts";

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

const KV_RE = /^([A-Za-z][\w.-]*)=(.+)$/;

export function parseCommand(rawText: string, knownActions: ReadonlySet<string>): ParsedCommand {
  const text = normalizeChatText(rawText);
  if (!/^run(\s|$)/i.test(text)) {
    return { kind: "read", query: text };
  }
  const tokens = text
    .split(" ")
    .slice(1)
    .filter((t) => t.length > 0);
  const actionType = tokens.shift();
  if (actionType === undefined) {
    return { kind: "refused", reason: "ambiguous_command", detail: "`run` needs an action." };
  }
  if (!knownActions.has(actionType)) {
    return { kind: "refused", reason: "unknown_action", detail: `Unknown action '${actionType}'.` };
  }
  const args: Record<string, string> = {};
  for (const t of tokens) {
    const m = KV_RE.exec(t);
    if (m === null) {
      return {
        kind: "refused",
        reason: "ambiguous_command",
        detail: `Bad argument '${t}' (use k=v).`,
      };
    }
    args[m[1] as string] = (m[2] as string).replace(/^"(.*)"$/, "$1");
  }
  const resource = args["service"] ?? args["resource"] ?? args["app"];
  if (resource === undefined) {
    return {
      kind: "refused",
      reason: "ambiguous_command",
      detail: "Write needs a resource (service=… / resource=… / app=…).",
    };
  }
  return { kind: "write", actionType, args, resource };
}

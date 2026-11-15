/**
 * `nimbus agent hook claude-code`: the PreToolUse hook the Claude Code kit installs (AD7b).
 *
 * Claude Code runs it before a Bash or PowerShell tool call, with the call as JSON on stdin. It
 * answers `deny` with a reason for a command in the steer table, and NOTHING for everything else,
 * which leaves the call to Claude Code's own permission flow.
 *
 * It FAILS OPEN on purpose: unreadable stdin, a shape it does not know, or a command it cannot
 * split is "no decision". This is guidance; a hook that blocked every shell call on a parse error
 * would make the agent unusable and teach its owner to remove the kit.
 *
 * Pure and self-contained: no gateway connection, no file, no environment. It imports only the
 * steer table (a test pins that), so it answers at once whether or not Nimbus is running.
 */
import { matchSteer, OWNER_COMMAND_REASON, steerReason } from "./steer-table.ts";

export type HookDecision =
  | { readonly decision: "none" }
  | { readonly decision: "deny"; readonly reason: string };

const NONE: HookDecision = { decision: "none" };

/** The shells whose `tool_input.command` is a command line. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "PowerShell"]);

/**
 * The simple commands of a command line: split on `&&`, `||`, `|&`, `;`, `|`, `&` and a line break,
 * the separators Claude Code's own permission rules use, but NOT inside single or double quotes.
 * `git commit -m "why we avoid gh pr merge; see docs"` is one command, and it is `git`.
 *
 * It does not understand a here-document: a line of one that starts with a steered command is
 * read as that command. Stated on the kit page; the hook errs toward one refusal the agent can
 * rephrase around, never toward silence about a real one.
 */
function splitCommands(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i] ?? "";
    if (quote !== "") {
      if (c === quote) quote = "";
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ";" || c === "\n" || c === "&" || c === "|") {
      parts.push(current);
      current = "";
      const next = line[i + 1];
      if ((c === "&" || c === "|") && (next === "&" || next === "|")) i += 1;
    } else {
      current += c;
    }
  }
  parts.push(current);
  return parts;
}

/** `NAME=value` before the program, which a shell treats as an assignment for that command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function unquote(word: string): string {
  const first = word[0];
  if (word.length >= 2 && (first === '"' || first === "'") && word.endsWith(first)) {
    return word.slice(1, -1);
  }
  return word;
}

/** The words of one simple command, with leading assignments and a leading `sudo` dropped. */
function wordsOf(part: string): string[] {
  const words = part
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")
    .map(unquote);
  let i = 0;
  while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i += 1;
  if (words[i] === "sudo") i += 1;
  return words.slice(i);
}

/** What the hook answers for one command line. */
export function decideCommand(command: string): HookDecision {
  for (const part of splitCommands(command)) {
    const match = matchSteer(wordsOf(part));
    if (match?.kind === "owner") return { decision: "deny", reason: OWNER_COMMAND_REASON };
    if (match?.kind === "steer") {
      return { decision: "deny", reason: steerReason(match.row.actionType) };
    }
  }
  return NONE;
}

/** What the hook answers for the JSON Claude Code wrote to stdin. Never throws. */
export function decideHook(stdinText: string): HookDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdinText);
  } catch {
    return NONE;
  }
  if (typeof parsed !== "object" || parsed === null) return NONE;
  const call = parsed as Record<string, unknown>;
  const tool = call["tool_name"];
  const input = call["tool_input"];
  if (typeof tool !== "string" || !SHELL_TOOLS.has(tool)) return NONE;
  if (typeof input !== "object" || input === null) return NONE;
  const command = (input as Record<string, unknown>)["command"];
  return typeof command === "string" ? decideCommand(command) : NONE;
}

/** The stdout Claude Code reads: its documented deny shape, or nothing. */
export function hookOutput(d: HookDecision): string {
  if (d.decision === "none") return "";
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: d.reason,
    },
  })}\n`;
}

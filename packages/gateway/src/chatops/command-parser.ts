import { parseAgentCommand } from "../agent-commands/parse-agent-command.ts";
import { normalizeChatText } from "./normalize-chat-text.ts";
import type { ParsedCommand } from "./types.ts";

export { normalizeChatText } from "./normalize-chat-text.ts";

const KV_RE = /^([A-Za-z][\w.-]*)=(.+)$/;

// `parseAgentCommand`'s own refusal text is the only signal available here — it never returns a
// structured reason code, by design (see its doc comment: `agents-rpc.ts` owns validation and its
// `-32602` text is the message the user should see). This substring match is therefore keyed to the
// ONE detail string `parseAgentCommand` emits for an unknown/unavailable agent name; every other
// refusal from it (missing agent name, bad `k=v` syntax, unknown param, bad param value) is a
// malformed-command shape, not an unknown-agent shape, hence `bad_agent_params`.
const UNKNOWN_AGENT_RE = /^Unknown or unavailable agent /;

export function parseCommand(
  rawText: string,
  knownActions: ReadonlySet<string>,
  permittedAgents: ReadonlySet<string>,
): ParsedCommand {
  const text = normalizeChatText(rawText);

  // Checked first: `agent <name> k=v` and `run <action> k=v` are disjoint grammars (the leading
  // keyword is what keeps them disjoint — see parseAgentCommand's doc comment), so order between
  // them never matters for a well-formed message. What DOES matter is that this runs before the
  // read fallthrough below: `null` means "not an agent command" and falls through unchanged, but
  // `{ ok: false }` is a refusal and must NOT fall through — sending a malformed agent command to
  // the LLM as a free-text question would be silently wrong instead of loudly refused.
  const agentCmd = parseAgentCommand(text, permittedAgents);
  if (agentCmd !== null) {
    if (agentCmd.ok) {
      return { kind: "agent", agent: agentCmd.agent, params: agentCmd.params };
    }
    return {
      kind: "refused",
      reason: UNKNOWN_AGENT_RE.test(agentCmd.detail) ? "unknown_agent" : "bad_agent_params",
      detail: agentCmd.detail,
    };
  }

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

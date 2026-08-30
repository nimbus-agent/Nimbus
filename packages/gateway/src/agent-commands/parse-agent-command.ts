import { normalizeChatText } from "../chatops/normalize-chat-text.ts";
import { AGENT_PARAM_KINDS, type ParamKind } from "../ipc/agent-param-kinds.ts";

export type AgentCommand =
  | { readonly ok: true; readonly agent: string; readonly params: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: "unknown_agent" | "bad_agent_params";
      readonly detail: string;
    };

const KV_RE = /^([A-Za-z][\w.-]*)=(.+)$/;

function coerce(raw: string, kind: ParamKind, field: string): unknown | { error: string } {
  switch (kind) {
    case "string":
      return raw;
    case "stringArray":
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      return { error: `${field} must be true or false` };
    }
    case "number": {
      const n = Number(raw);
      // Number.isFinite, NOT !Number.isNaN. `typeof NaN === "number"`, and `minConfidence`'s
      // validator (`typeof !== "number" || < 0 || > 1`) is entirely false for NaN — so NaN would
      // reach the agent and every `confidence >= NaN` comparison would be false, producing a brief
      // with zero decisions and no error. Infinity is rejected for the same class of reason.
      if (!Number.isFinite(n)) return { error: `${field} must be a finite number` };
      return n;
    }
  }
}

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * `agent <name> [k=v ...]` -> the params `dispatchAgentsRpc` validates, or a refusal.
 *
 * `null` means "not an agent command" — the caller falls through to its existing behaviour. That
 * distinction matters: without the `agent` keyword, `@nimbus why is checkout slow?` would stop
 * being a question and become a malformed agent call.
 *
 * This function COERCES and never validates. It does not know a bound, a required field, or that
 * `ownership`'s `path` and `service` are mutually exclusive — `agents-rpc.ts` owns all of that and
 * its own `-32602` text is what the user should see, because it is the real message rather than a
 * mirrored one. Surface-neutral by design: its only import beyond the param-kinds map is the
 * neutral `normalizeChatText` — never `chatops/command-parser.ts` itself, which imports
 * `parseAgentCommand` (not the reverse) — so a CLI or browser text surface can reuse it unchanged.
 *
 * A refusal carries a structured `reason` alongside its human-readable `detail` precisely so a
 * caller like `command-parser.ts` never has to regex-match the prose to recover why the parse
 * failed — `detail` is for the user, `reason` is for the caller.
 */
export function parseAgentCommand(
  rawText: string,
  permitted: ReadonlySet<string>,
): AgentCommand | null {
  const text = normalizeChatText(rawText);
  if (!/^agent(\s|$)/i.test(text)) return null;

  const tokens = text
    .split(" ")
    .slice(1)
    .filter((t) => t.length > 0);
  const agent = tokens.shift();
  if (agent === undefined)
    return { ok: false, reason: "bad_agent_params", detail: "`agent` needs an agent name." };
  if (!permitted.has(agent))
    return {
      ok: false,
      reason: "unknown_agent",
      detail: `Unknown or unavailable agent '${agent}'.`,
    };

  const kinds = AGENT_PARAM_KINDS[agent] ?? {};
  const params: Record<string, unknown> = {};
  for (const t of tokens) {
    const m = KV_RE.exec(t);
    if (m === null)
      return { ok: false, reason: "bad_agent_params", detail: `Bad argument '${t}' (use k=v).` };
    const field = m[1] as string;
    const value = (m[2] as string).replace(/^"(.*)"$/, "$1");
    const kind = kinds[field];
    if (kind === undefined)
      return {
        ok: false,
        reason: "bad_agent_params",
        detail: `'${agent}' has no parameter '${field}'.`,
      };
    const coerced = coerce(value, kind, field);
    if (isError(coerced)) return { ok: false, reason: "bad_agent_params", detail: coerced.error };
    params[field] = coerced;
  }
  return { ok: true, agent, params };
}

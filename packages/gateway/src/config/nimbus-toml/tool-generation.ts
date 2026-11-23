import { parseIntDec, parseString } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSectionFromConfig } from "./shared.ts";

export type ToolgenDraftingMode = "off" | "local" | "allow-remote";

export type NimbusToolGenerationToml = {
  enabled: boolean;
  /**
   * Which model may author a tool body. Mirrors `[agents] synthesis` (I31) and `[fleet]
   * allow_remote` (I38): a frontier key configured for interactive use grants drafting nothing.
   * Defaults to "local" because a remote draft sends the owner's description AND indexed endpoint
   * paths drawn from their private index.
   */
  drafting: ToolgenDraftingMode;
  maxToolsPerSession: number;
  maxRequestsPerTool: number;
  requestTimeoutMs: number;
  /**
   * The SAVED tool ids the owner offers to the conversational model (S4, I60). Default empty: no
   * generated tool is offered. Exact ids only (no glob); every call still asks the owner over its
   * verbatim input (`toolgen/toolgen-model-door.ts`).
   */
  modelTools: readonly string[];
};

/**
 * DEFAULT OFF. `allow_agent_initiated` and `allowed_hosts` are deliberately ABSENT in PR 1 — they
 * belong to the agent-initiated path (spec § 9.1) and a key parsed but unused would read as a
 * shipped control that does nothing.
 */
export const DEFAULT_NIMBUS_TOOL_GENERATION_TOML: NimbusToolGenerationToml = {
  enabled: false,
  drafting: "local",
  maxToolsPerSession: 3,
  maxRequestsPerTool: 50,
  requestTimeoutMs: 10_000,
  modelTools: [],
};

function applyNimbusToolGenerationKey(
  out: Partial<NimbusToolGenerationToml>,
  key: string,
  valRaw: string,
): void {
  // A non-positive value leaves the default in place rather than assigning it: `max_requests_per_tool = 0`
  // must not silently mean "no requests allowed", and a negative timeout must not mean "expire at once".
  const positive = (assign: (n: number) => void): void => {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) assign(n);
  };
  switch (key) {
    case "enabled":
      out.enabled = valRaw.trim().toLowerCase() === "true";
      break;
    case "max_tools_per_session":
      positive((n) => {
        out.maxToolsPerSession = n;
      });
      break;
    case "max_requests_per_tool":
      positive((n) => {
        out.maxRequestsPerTool = n;
      });
      break;
    case "request_timeout_ms":
      positive((n) => {
        out.requestTimeoutMs = n;
      });
      break;
    case "model_tools":
      out.modelTools = parseModelToolIds(valRaw);
      break;
    case "drafting": {
      // An unrecognised value leaves the default in place, matching the positive-number keys
      // above: a typo must never widen what may draft. Mirrors `setEmbeddingProvider`'s
      // closed-enum-string shape (nimbus-toml.ts:174-178).
      const v = parseString(valRaw).toLowerCase();
      if (v === "off" || v === "local" || v === "allow-remote") {
        out.drafting = v;
      }
      break;
    }
    default:
      break;
  }
}

/** A saved tool id the `model_tools` list may name: the id alphabet, nothing that could be a glob. */
const MODEL_TOOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `model_tools`: exact ids, de-duplicated in the owner's order. Only a QUOTED entry counts: a bare
 * token (`123`, `true`, a word) is dropped, never read as an id, so the list names only strings the
 * owner wrote as strings. An entry that is not an id is dropped (never widened into a match), and a
 * value that is not one bracketed array is the empty list.
 */
function parseModelToolIds(valRaw: string): string[] {
  const v = valRaw.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return [];
  const out: string[] = [];
  for (const raw of v.slice(1, -1).split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const quoted = MODEL_TOOL_QUOTED.exec(entry);
    if (quoted === null) continue;
    const id = quoted[2] ?? "";
    if (MODEL_TOOL_ID_PATTERN.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** One quoted entry: double or single quotes, nothing outside them. */
const MODEL_TOOL_QUOTED = /^(["'])([^"']*)\1$/;

export function parseNimbusToolGenerationToml(
  raw: string,
  defaults: NimbusToolGenerationToml = DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
): NimbusToolGenerationToml {
  const out: Partial<NimbusToolGenerationToml> = {};
  forEachSectionEntry(raw, "[tool_generation]", (key, valRaw) => {
    applyNimbusToolGenerationKey(out, key, valRaw);
  });
  return { ...defaults, ...out };
}

export function loadNimbusToolGenerationFromConfigDir(configDir: string): NimbusToolGenerationToml {
  return loadTomlSectionFromConfig(
    configDir,
    "tool_generation",
    DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
    parseNimbusToolGenerationToml,
  );
}

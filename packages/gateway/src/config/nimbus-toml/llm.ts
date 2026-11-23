import { DEFAULT_LOCAL_CONTEXT_TOKENS } from "../../llm/ollama-provider.ts";
import type { LlmTaskType } from "../../llm/types.ts";
import { resolveServiceTableId } from "../service-config-toml.ts";
import { parseBool, parseString, parseStringArray } from "../toml-primitives.ts";
import {
  assignBool,
  assignBoundedInt,
  collectSubTableKv,
  forEachSectionEntry,
  loadTomlSection,
  loadTomlSectionFromConfig,
} from "./shared.ts";

/** One `[llm.local.<name>]` sub-table: a named local model route. Spec §3.6. */
export type NimbusLlmLocalRoute = {
  runtime: string;
  model: string;
  baseUrl?: string;
};

/**
 * One `[llm.remote.<vendor>]` sub-table: a cloud vendor opt-in. Slice 2b spec §7.1.
 *
 * `enabled` DEFAULTS TO FALSE and is never inferred from the presence of a key. Per-vendor rather
 * than one global remote toggle, so enabling Gemini cannot silently enable another vendor because
 * an unrelated credential happens to exist.
 *
 * `baseUrl` is a proxy override and does NOT affect locality — a cloud adapter hardcodes
 * `isLocal = false` even on a loopback base URL, because the proxy forwards to the vendor
 * (invariant I34).
 */
export type NimbusLlmRemoteVendor = {
  enabled: boolean;
  model: string;
  baseUrl?: string;
};

export type NimbusLlmToml = {
  preferLocal: boolean;
  localModel: string;
  /**
   * `num_ctx` for the local provider, in tokens. See `DEFAULT_LOCAL_CONTEXT_TOKENS`: unset is
   * NOT neutral, it hands the prompt window to Ollama's own 4096 default and its silent
   * front-truncation. Tunable because the RAM cost is the user machine's.
   */
  localContextTokens: number;
  llamacppServerPath: string;
  minReasoningParams: number;
  enforceAirGap: boolean;
  maxAgentDepth: number;
  maxToolCallsPerSession: number;
  /**
   * Named `[llm.local.<name>]` sub-tables, keyed by name. Collected verbatim here —
   * NO validation (resolving `route_priority` references, `base_url` collision
   * checks) happens at this layer. See the module doc above `parseNimbusTomlLlmSection`
   * for why: validation throws would be swallowed by `loadTomlSection`'s bare catch and
   * silently revert the whole `[llm]` section to defaults. Validation lives in
   * `platform/assemble.ts` (Task 9), against the loaded config, where a bad entry can be
   * logged and dropped without discarding anything else.
   */
  localRoutes: ReadonlyMap<string, NimbusLlmLocalRoute>;
  /**
   * Named `[llm.remote.<vendor>]` sub-tables, keyed by vendor id VERBATIM from the header.
   * Collected without validation, exactly like `localRoutes`: an unknown vendor id, an
   * `enabled = true` with no resolvable key, and an empty model are all `platform/assemble.ts`'s
   * to warn about BY NAME and drop. A throw here would be swallowed by `loadTomlSection`'s bare
   * catch and revert the whole `[llm]` section to defaults, `enforce_air_gap` included.
   */
  remoteVendors: ReadonlyMap<string, NimbusLlmRemoteVendor>;
  /**
   * Verbatim `route_priority` entries — un-resolved route references, in file order.
   * See `localRoutes` doc: resolving each entry against a registered route (built-in or
   * `[llm.local.*]`) is Task 9's job, not this parser's.
   */
  routePriority: readonly string[];
  /**
   * The `[llm.tasks]` table: task type -> pinned route id, verbatim and un-resolved (same
   * division of labour as `routePriority` — resolving a pin against the route table is the
   * router's job, Task 6, not this parser's). Optional rather than defaulted to an empty map,
   * matching the `localRoutes`/`remoteVendors` shape above: set only when at least one entry
   * survived parsing. "No table configured" and "a table whose entries were all dropped as
   * malformed" both leave this field `undefined` — that pair is NOT distinguishable here, and
   * that is fine, because the router's fallback ("no usable pin for this task, fall back to
   * `routePriority`") is the correct behaviour for both cases; there is no decision downstream
   * that needs to tell them apart.
   */
  taskPins?: ReadonlyMap<LlmTaskType, string>;
};

export const DEFAULT_NIMBUS_LLM_TOML: NimbusLlmToml = {
  preferLocal: true,
  localModel: "llama3.2",
  localContextTokens: DEFAULT_LOCAL_CONTEXT_TOKENS,
  llamacppServerPath: "",
  minReasoningParams: 7,
  enforceAirGap: false,
  maxAgentDepth: 3,
  maxToolCallsPerSession: 20,
  localRoutes: new Map(),
  remoteVendors: new Map(),
  routePriority: [],
};

function applyNimbusLlmKey(out: Partial<NimbusLlmToml>, key: string, valRaw: string): void {
  switch (key) {
    case "prefer_local":
      assignBool(valRaw, (b) => {
        out.preferLocal = b;
      });
      break;
    // `remote_model` was removed on 2026-08-28 alongside `classifier_model`, for the same
    // reason and with the same handling: a stale key in an existing nimbus.toml is ignored.
    // `classifier_model` was removed on 2026-08-28 and is deliberately NOT parsed here: the
    // intent classifier no longer owns an HTTP client that could take a model name, it asks
    // `LlmRouter` for the `"classification"` task and takes whatever route answers. A stale key
    // in an existing nimbus.toml is ignored, the same as any other unrecognised [llm] key.
    case "local_model":
      out.localModel = parseString(valRaw);
      break;
    case "llamacpp_server_path":
      out.llamacppServerPath = parseString(valRaw);
      break;
    case "min_reasoning_params":
      assignBoundedInt(valRaw, { min: 1, max: Number.MAX_SAFE_INTEGER }, (n) => {
        out.minReasoningParams = n;
      });
      break;
    case "enforce_air_gap":
      assignBool(valRaw, (b) => {
        out.enforceAirGap = b;
      });
      break;
    case "max_agent_depth":
      assignBoundedInt(valRaw, { min: 1, max: 10 }, (n) => {
        out.maxAgentDepth = n;
      });
      break;
    case "max_tool_calls_per_session":
      assignBoundedInt(valRaw, { min: 1, max: 200 }, (n) => {
        out.maxToolCallsPerSession = n;
      });
      break;
    case "route_priority": {
      // `parseStringArray` THROWS on a non-bracket-delimited value. Unguarded, that
      // escapes into `loadTomlSection`'s catch and reverts the WHOLE [llm] section —
      // see the doc above `NimbusLlmToml.routePriority`. Swallow it here instead:
      // `routePriority` stays unset, every other key in the section survives. This is
      // ALSO where the two superseded-by-the-brief "malformed entry throws" tests would
      // have lived — they don't, on purpose: validating each entry (e.g. via
      // `parseRouteRef`) is Task 9's job against the loaded config, not this parser's.
      try {
        out.routePriority = parseStringArray(valRaw);
      } catch {
        /* malformed: leave routePriority unset, fall back to the default (empty) */
      }
      break;
    }
    case "local_context_tokens":
      // A window below what `num_predict` alone reserves cannot hold a prompt at all, so a typo
      // there would be worse than the default it replaced. Rejected rather than clamped, per
      // `assignBoundedInt`.
      assignBoundedInt(valRaw, { min: 2048, max: Number.MAX_SAFE_INTEGER }, (n) => {
        out.localContextTokens = n;
      });
      break;
    default:
      break;
  }
}

const LLM_LOCAL_TABLE_PREFIX = "[llm.local.";
const LLM_REMOTE_TABLE_PREFIX = "[llm.remote.";

/**
 * If `trimmed` is a `[llm.local.<name>]` header, resolves its id via the shared
 * `resolveServiceTableId` helper (reused from `service-config-toml.ts` rather than a
 * second copy of the same prefix-match-and-slice logic). That helper THROWS on an
 * empty id (`[llm.local.]`) — correct for its own `[metrics.dora.*]`/`[ci.service.*]`
 * callers, wrong here: this parser must never throw (see the doc above
 * `NimbusLlmToml.localRoutes`). Catch it locally and treat it as "skip this one
 * malformed block" — matching the `[ownership]`/`[hitl.quorum]` precedent elsewhere in
 * this file, where one bad entry is dropped rather than discarding the section.
 */
function beginLlmTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
  prefix: string,
  label: string,
): string | undefined {
  try {
    return resolveServiceTableId(trimmed, prefix, label, accum);
  } catch {
    return undefined;
  }
}

/** Accumulates raw kv strings per `[llm.<kind>.<id>]` sub-table; see {@link collectSubTableKv}. */
function collectLlmKvSections(
  source: string,
  prefix: string,
  label: string,
): Map<string, Record<string, string>> {
  return collectSubTableKv(source, (accum, trimmed) =>
    beginLlmTable(accum, trimmed, prefix, label),
  );
}

/** Accumulates raw kv strings per `[llm.local.<name>]` sub-table. */
function collectLlmLocalKvSections(source: string): Map<string, Record<string, string>> {
  return collectLlmKvSections(source, LLM_LOCAL_TABLE_PREFIX, "llm.local");
}

/**
 * Validates one `[llm.remote.<vendor>]` sub-table's raw kv strings into a vendor, or `undefined`
 * when structurally unusable (no `model`). An absent `enabled` and an explicit `enabled = false`
 * mean the same thing, so no absent-versus-explicit discrimination is needed here or downstream —
 * which is what lets `platform/assemble.ts` validate AFTER defaults are applied rather than
 * closer to the parser, where a throw would trip `loadTomlSection`'s bare catch.
 */
function toLlmRemoteVendor(kv: Record<string, string>): NimbusLlmRemoteVendor | undefined {
  const modelRaw = kv["model"];
  if (modelRaw === undefined) return undefined;
  const model = parseString(modelRaw);
  if (model.length === 0) return undefined;
  const enabledRaw = kv["enabled"];
  const vendor: NimbusLlmRemoteVendor = {
    enabled: enabledRaw === undefined ? false : (parseBool(enabledRaw) ?? false),
    model,
  };
  const baseUrlRaw = kv["base_url"];
  if (baseUrlRaw !== undefined) {
    const baseUrl = parseString(baseUrlRaw);
    if (baseUrl.length > 0) vendor.baseUrl = baseUrl;
  }
  return vendor;
}

/** Parses every `[llm.remote.<vendor>]` sub-table into a vendor → config map. Never throws. */
function parseLlmRemoteVendors(source: string): Map<string, NimbusLlmRemoteVendor> {
  const out = new Map<string, NimbusLlmRemoteVendor>();
  for (const [id, kv] of collectLlmKvSections(source, LLM_REMOTE_TABLE_PREFIX, "llm.remote")) {
    const vendor = toLlmRemoteVendor(kv);
    if (vendor !== undefined) out.set(id, vendor);
  }
  return out;
}

/**
 * Validates one `[llm.local.<name>]` sub-table's raw kv strings into a route, or
 * `undefined` when structurally unusable (missing `runtime`/`model`). No OTHER
 * validation happens here — a runtime/model value that doesn't name a real thing, or
 * a `base_url` that collides with another route, is Task 9's problem against the
 * loaded config, not this parser's.
 */
function toLlmLocalRoute(kv: Record<string, string>): NimbusLlmLocalRoute | undefined {
  const runtimeRaw = kv["runtime"];
  const modelRaw = kv["model"];
  if (runtimeRaw === undefined || modelRaw === undefined) return undefined;
  const runtime = parseString(runtimeRaw);
  const model = parseString(modelRaw);
  if (runtime.length === 0 || model.length === 0) return undefined;
  const route: NimbusLlmLocalRoute = { runtime, model };
  const baseUrlRaw = kv["base_url"];
  if (baseUrlRaw !== undefined) {
    const baseUrl = parseString(baseUrlRaw);
    if (baseUrl.length > 0) route.baseUrl = baseUrl;
  }
  return route;
}

/** Parses every `[llm.local.<name>]` sub-table into a name → route map. Never throws. */
function parseLlmLocalRoutes(source: string): Map<string, NimbusLlmLocalRoute> {
  const out = new Map<string, NimbusLlmLocalRoute>();
  for (const [id, kv] of collectLlmLocalKvSections(source).entries()) {
    const route = toLlmLocalRoute(kv);
    if (route !== undefined) out.set(id, route);
  }
  return out;
}

/**
 * Totality-checked membership set for `LlmTaskType`, keyed as a `Record` rather than kept as a
 * plain string array so that adding a fifth task type to the union without adding it here is a
 * TYPE ERROR — the parser below cannot silently fall behind the type it validates `[llm.tasks]`
 * keys against.
 */
const LLM_TASK_TYPE_MEMBERS: Record<LlmTaskType, true> = {
  classification: true,
  reasoning: true,
  summarisation: true,
  agent_step: true,
};

function isLlmTaskType(key: string): key is LlmTaskType {
  return Object.hasOwn(LLM_TASK_TYPE_MEMBERS, key);
}

/**
 * Parses the flat `[llm.tasks]` table into a task -> route-id map. Unlike `[llm.local.*]` /
 * `[llm.remote.*]`, this is a single fixed-name table (no per-entry sub-header), so it reuses
 * `forEachSectionEntry` directly rather than the `collectLlmKvSections` machinery built for
 * dynamic sub-table ids.
 *
 * An unrecognised key (a typo, or a task type a newer build added that this one doesn't know)
 * is DROPPED, never thrown: same reasoning as `route_priority` above — a throw here would
 * escape into `loadTomlSection`'s bare catch and revert the WHOLE `[llm]` section,
 * `enforce_air_gap` included. Resolving a pinned id against the route table is Task 6's job
 * against the loaded config, not this parser's.
 */
function parseLlmTaskPins(source: string): Map<LlmTaskType, string> {
  const out = new Map<LlmTaskType, string>();
  forEachSectionEntry(source, "[llm.tasks]", (key, valRaw) => {
    if (!isLlmTaskType(key)) return;
    const routeId = parseString(valRaw);
    if (routeId.length > 0) out.set(key, routeId);
  });
  return out;
}

export function parseNimbusTomlLlmSection(source: string): Partial<NimbusLlmToml> {
  const out: Partial<NimbusLlmToml> = {};
  forEachSectionEntry(source, "[llm]", (key, valRaw) => {
    applyNimbusLlmKey(out, key, valRaw);
  });
  // `forEachSectionEntry` matches `[llm]` by EXACT string equality, so it cannot see
  // `[llm.local.*]` sub-tables — this is a second, independent scan over the same
  // source. `Partial<>`: an absent `[llm.local.*]` block leaves `localRoutes` unset
  // (not an empty map), matching every other optional field here.
  const localRoutes = parseLlmLocalRoutes(source);
  if (localRoutes.size > 0) out.localRoutes = localRoutes;
  // Same second-scan reasoning and the same `Partial<>` contract as `localRoutes` above: an
  // absent `[llm.remote.*]` block leaves `remoteVendors` UNSET rather than an empty map, so
  // `assemble.ts` can tell "no vendor tables" from "vendor tables that all dropped".
  const remoteVendors = parseLlmRemoteVendors(source);
  if (remoteVendors.size > 0) out.remoteVendors = remoteVendors;
  // Same second-scan reasoning as `localRoutes`/`remoteVendors` above: `taskPins` stays OPTIONAL
  // on the full `NimbusLlmToml` (not defaulted to an empty map), set only when at least one entry
  // survived parsing — see the doc above `NimbusLlmToml.taskPins` for why collapsing "no table"
  // and "an all-dropped table" to the same `undefined` is fine here.
  const taskPins = parseLlmTaskPins(source);
  if (taskPins.size > 0) out.taskPins = taskPins;
  return out;
}

function parseNimbusLlmLoaded(raw: string): NimbusLlmToml {
  return structuredClone({
    ...DEFAULT_NIMBUS_LLM_TOML,
    ...parseNimbusTomlLlmSection(raw),
  });
}

export function loadNimbusLlmFromPath(tomlPath: string): NimbusLlmToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_LLM_TOML, parseNimbusLlmLoaded);
}

export function loadNimbusLlmPartialFromPath(tomlPath: string): Partial<NimbusLlmToml> {
  return loadTomlSection<Partial<NimbusLlmToml>>(tomlPath, {}, parseNimbusTomlLlmSection);
}

export function loadNimbusLlmFromConfigDir(configDir: string): NimbusLlmToml {
  return loadTomlSectionFromConfig(configDir, "llm", DEFAULT_NIMBUS_LLM_TOML, parseNimbusLlmLoaded);
}

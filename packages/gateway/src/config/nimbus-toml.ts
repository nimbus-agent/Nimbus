import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LOCAL_CONTEXT_TOKENS } from "../llm/ollama-provider.ts";
import type { LlmTaskType } from "../llm/types.ts";

import type { ServiceConfig } from "../metrics/dora-config.ts";
import { processEnvGet } from "../platform/env-access.ts";
import {
  parseNimbusCiServiceToml,
  parseNimbusDoraToml,
  resolveServiceTableId,
} from "./service-config-toml.ts";
import {
  hasUnterminatedString,
  isTableHeader,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

// Re-export the DORA / CI service-config surface so external importers
// (http-server.ts, ipc/server/dispatchers.ts, config + metrics tests) keep
// working through `./nimbus-toml.ts` unchanged.
export * from "./service-config-toml.ts";

function loadTomlSection<T>(tomlPath: string, fallback: T, parse: (raw: string) => T): T {
  if (!existsSync(tomlPath)) {
    return structuredClone(fallback);
  }
  try {
    return parse(readFileSync(tomlPath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

export type NimbusEmbeddingToml = {
  enabled: boolean;
  provider: "local" | "openai" | "hybrid";
  model: string;
  chunkTokens: number;
  chunkOverlapTokens: number;
  backfillBatchSize: number;
  pauseOnBattery: boolean;
};

export const DEFAULT_NIMBUS_EMBEDDING_TOML: NimbusEmbeddingToml = {
  enabled: true,
  provider: "local",
  model: "all-MiniLM-L6-v2",
  chunkTokens: 256,
  chunkOverlapTokens: 32,
  backfillBatchSize: 50,
  pauseOnBattery: true,
};

function parseBool(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  return undefined;
}

/**
 * Assign a boolean key when — and only when — the raw value actually parses as one.
 *
 * The whole file's contract for a malformed value is "leave the field UNSET so the default
 * survives", never "coerce to false"; written once here so the ~30 boolean keys in this file
 * cannot each re-derive it and one of them get it wrong.
 */
function assignBool(valRaw: string, assign: (b: boolean) => void): void {
  const b = parseBool(valRaw);
  if (b !== undefined) assign(b);
}

/**
 * Assign an integer key when it parses AND lands inside `[min, max]` (both inclusive).
 *
 * Out-of-range is REJECTED, not clamped: clamping leaves the running config silently disagreeing
 * with what the file says, which is the harder of the two failures to diagnose.
 */
function assignBoundedInt(
  valRaw: string,
  bounds: { readonly min: number; readonly max: number },
  assign: (n: number) => void,
): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= bounds.min && n <= bounds.max) assign(n);
}

/**
 * `enabled` — the one toggle EVERY pass section has.
 *
 * Split from `applyPassSectionToggle` below rather than folded into it, because a section that
 * does not declare `use_llm` must not have one INVENTED for it: `out` here is a
 * `Partial<Nimbus…Toml>` that gets spread over the defaults, so writing a field the type does not
 * carry puts a key in the returned config that nothing reads and every equality assertion sees.
 * `[ownership]` is that section.
 */
function applyEnabledToggle(out: { enabled?: boolean }, key: string, valRaw: string): boolean {
  if (key !== "enabled") return false;
  assignBool(valRaw, (b) => {
    out.enabled = b;
  });
  return true;
}

/**
 * The `enabled` / `use_llm` prelude shared by the three LLM-backed pass sections — `[glossary]`,
 * `[decisions]` and `[premortem]`.
 *
 * It MUST run before each section's integer branch, and that ordering is precisely why it is one
 * function rather than three copies: routed through `parseIntDec`, `use_llm` is silently dropped
 * and the section reads as if it were never set.
 *
 * Returns true when the key was one of the two and has been HANDLED — including when the value
 * was malformed and deliberately left unset, which is still handled and must not fall through to
 * a numeric parse.
 */
function applyPassSectionToggle(
  out: { enabled?: boolean; useLlm?: boolean },
  key: string,
  valRaw: string,
): boolean {
  if (applyEnabledToggle(out, key, valRaw)) return true;
  if (key !== "use_llm") return false;
  assignBool(valRaw, (b) => {
    out.useLlm = b;
  });
  return true;
}

function forEachSectionEntry(
  source: string,
  sectionHeader: string,
  onEntry: (key: string, valRaw: string) => void,
): void {
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) {
      continue;
    }
    if (trimmed === "") {
      continue;
    }
    if (isTableHeader(trimmed)) {
      inSection = trimmed === sectionHeader;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) {
      onEntry(kv.key, kv.valRaw);
    }
  }
}

function setEmbeddingEnabled(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.enabled = b;
  }
}

function setEmbeddingPauseOnBattery(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.pauseOnBattery = b;
  }
}

function setEmbeddingProvider(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const p = parseString(valRaw).toLowerCase();
  if (p === "local" || p === "openai" || p === "hybrid") {
    out.provider = p;
  }
}

function setEmbeddingPositiveInt(
  out: Partial<NimbusEmbeddingToml>,
  valRaw: string,
  field: "chunkTokens" | "backfillBatchSize",
): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n > 0) {
    out[field] = n;
  }
}

function setEmbeddingOverlapTokens(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= 0) {
    out.chunkOverlapTokens = n;
  }
}

function applyNimbusEmbeddingKey(
  out: Partial<NimbusEmbeddingToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled":
      setEmbeddingEnabled(out, valRaw);
      break;
    case "provider":
      setEmbeddingProvider(out, valRaw);
      break;
    case "model":
      out.model = parseString(valRaw);
      break;
    case "chunk_tokens":
      setEmbeddingPositiveInt(out, valRaw, "chunkTokens");
      break;
    case "chunk_overlap_tokens":
      setEmbeddingOverlapTokens(out, valRaw);
      break;
    case "backfill_batch_size":
      setEmbeddingPositiveInt(out, valRaw, "backfillBatchSize");
      break;
    case "pause_on_battery":
      setEmbeddingPauseOnBattery(out, valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlEmbeddingSection(source: string): Partial<NimbusEmbeddingToml> {
  const out: Partial<NimbusEmbeddingToml> = {};
  forEachSectionEntry(source, "[embedding]", (key, valRaw) => {
    applyNimbusEmbeddingKey(out, key, valRaw);
  });
  return out;
}

export function resolveNimbusTomlForProfile(configDir: string): string {
  const p = processEnvGet("NIMBUS_PROFILE")?.trim();
  if (p === undefined || p === "" || p === "default") {
    return join(configDir, "nimbus.toml");
  }
  const alt = join(configDir, `nimbus.${p}.toml`);
  return existsSync(alt) ? alt : join(configDir, "nimbus.toml");
}

export function loadNimbusEmbeddingFromPath(tomlPath: string): NimbusEmbeddingToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_EMBEDDING_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_EMBEDDING_TOML,
      ...parseNimbusTomlEmbeddingSection(raw),
    }),
  );
}

export function loadNimbusEmbeddingFromConfigDir(configDir: string): NimbusEmbeddingToml {
  return loadNimbusEmbeddingFromPath(join(configDir, "nimbus.toml"));
}

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

/**
 * Accumulates raw kv strings per `[llm.<kind>.<id>]` sub-table.
 *
 * `prefix`/`label` are the ONLY difference between the local-route and remote-vendor collectors,
 * so they share this one function rather than each carrying a copy of the header-reset behaviour
 * below — that reset fixed a real bug, and a second copy could regress it independently.
 */
function collectLlmKvSections(
  source: string,
  prefix: string,
  label: string,
): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    // Header-LIKE, not header-VALID: a line that opens with `[` is a table header the writer
    // meant, whether or not it closes. Ending the current block on the OPENING bracket — before
    // `isTableHeader` gets to reject `[llm.local.bad` for its missing `]` — is what makes a
    // malformed header end the previous route instead of leaking into it. Without the reset,
    // `currentId` stayed on the last VALID id, so every `runtime`/`model` line under the
    // malformed header was written into the PREVIOUS route's bucket: `[llm.local.good]` followed
    // by `[llm.local.bad` silently became `good` carrying `bad`'s runtime and model.
    if (trimmed.startsWith("[")) {
      currentId = isTableHeader(trimmed) ? beginLlmTable(accum, trimmed, prefix, label) : undefined;
      continue;
    }
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
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

export function loadNimbusLlmFromPath(tomlPath: string): NimbusLlmToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_LLM_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_LLM_TOML,
      ...parseNimbusTomlLlmSection(raw),
    }),
  );
}

export function loadNimbusLlmPartialFromPath(tomlPath: string): Partial<NimbusLlmToml> {
  return loadTomlSection<Partial<NimbusLlmToml>>(tomlPath, {}, parseNimbusTomlLlmSection);
}

export function loadNimbusLlmFromConfigDir(configDir: string): NimbusLlmToml {
  return loadNimbusLlmFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusVoiceToml = {
  enabled: boolean;
  whisperPath: string;
  whisperModel: string;
  wakeWordWhisperModel: string;
  wakeWord: string;
  piperPath: string;
  piperModel: string;
};

export const DEFAULT_NIMBUS_VOICE_TOML: NimbusVoiceToml = {
  enabled: false,
  whisperPath: "",
  whisperModel: "base.en",
  wakeWordWhisperModel: "tiny.en",
  wakeWord: "hey nimbus",
  piperPath: "",
  piperModel: "",
};

function applyNimbusVoiceKey(out: Partial<NimbusVoiceToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "whisper_path":
      out.whisperPath = parseString(valRaw);
      break;
    case "whisper_model":
      out.whisperModel = parseString(valRaw);
      break;
    case "wake_word_whisper_model":
      out.wakeWordWhisperModel = parseString(valRaw);
      break;
    case "wake_word":
      out.wakeWord = parseString(valRaw);
      break;
    case "piper_path":
      out.piperPath = parseString(valRaw);
      break;
    case "piper_model":
      out.piperModel = parseString(valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlVoiceSection(source: string): Partial<NimbusVoiceToml> {
  const out: Partial<NimbusVoiceToml> = {};
  forEachSectionEntry(source, "[voice]", (key, valRaw) => {
    applyNimbusVoiceKey(out, key, valRaw);
  });
  return out;
}

export function loadNimbusVoiceFromPath(tomlPath: string): NimbusVoiceToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_VOICE_TOML, (raw) =>
    structuredClone({
      ...DEFAULT_NIMBUS_VOICE_TOML,
      ...parseNimbusTomlVoiceSection(raw),
    }),
  );
}

export function loadNimbusVoiceFromConfigDir(configDir: string): NimbusVoiceToml {
  return loadNimbusVoiceFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusUpdaterToml = {
  enabled: boolean;
  url: string;
  checkOnStartup: boolean;
  autoApply: boolean;
};

export const DEFAULT_NIMBUS_UPDATER_TOML: NimbusUpdaterToml = {
  enabled: true,
  url: "https://github.com/nimbus-agent/Nimbus/releases/latest/download/latest.json",
  checkOnStartup: true,
  autoApply: false,
};

function applyNimbusUpdaterKey(out: Partial<NimbusUpdaterToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "url":
      out.url = parseString(valRaw);
      break;
    case "check_on_startup": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.checkOnStartup = b;
      break;
    }
    case "auto_apply": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.autoApply = b;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusTomlUpdaterSection(source: string): Partial<NimbusUpdaterToml> {
  const out: Partial<NimbusUpdaterToml> = {};
  forEachSectionEntry(source, "[updater]", (key, valRaw) => {
    applyNimbusUpdaterKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusUpdaterToml(
  raw: string,
  defaults: NimbusUpdaterToml = DEFAULT_NIMBUS_UPDATER_TOML,
): NimbusUpdaterToml {
  const section = parseNimbusTomlUpdaterSection(raw);
  const result: NimbusUpdaterToml = { ...defaults, ...section };

  const urlOverride = processEnvGet("NIMBUS_UPDATER_URL");
  if (urlOverride) {
    result.url = urlOverride;
  }
  if (processEnvGet("NIMBUS_UPDATER_DISABLE") === "1") {
    result.enabled = false;
  }
  return result;
}

export function loadNimbusUpdaterFromPath(tomlPath: string): NimbusUpdaterToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_UPDATER_TOML, parseNimbusUpdaterToml);
}

export function loadNimbusUpdaterFromConfigDir(configDir: string): NimbusUpdaterToml {
  return loadNimbusUpdaterFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusLanToml = {
  enabled: boolean;
  port: number;
  bind: string;
  pairingWindowSeconds: number;
  maxFailedAttempts: number;
  lockoutSeconds: number;
};

export const DEFAULT_NIMBUS_LAN_TOML: NimbusLanToml = {
  enabled: false,
  port: 7475,
  bind: "127.0.0.1",
  pairingWindowSeconds: 300,
  maxFailedAttempts: 3,
  lockoutSeconds: 60,
};

function applyNimbusLanKey(out: Partial<NimbusLanToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "port": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.port = n;
      break;
    }
    case "bind":
      out.bind = parseString(valRaw);
      break;
    case "pairing_window_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.pairingWindowSeconds = n;
      break;
    }
    case "max_failed_attempts": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxFailedAttempts = n;
      break;
    }
    case "lockout_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.lockoutSeconds = n;
      break;
    }
    default:
      break;
  }
}

function parseNimbusTomlLanSection(source: string): Partial<NimbusLanToml> {
  const out: Partial<NimbusLanToml> = {};
  forEachSectionEntry(source, "[lan]", (key, valRaw) => {
    applyNimbusLanKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusLanToml(
  raw: string,
  defaults: NimbusLanToml = DEFAULT_NIMBUS_LAN_TOML,
): NimbusLanToml {
  const section = parseNimbusTomlLanSection(raw);
  const result: NimbusLanToml = { ...defaults, ...section };

  const portOverride = processEnvGet("NIMBUS_LAN_PORT");
  if (portOverride) {
    const parsed = Number.parseInt(portOverride, 10);
    if (!Number.isNaN(parsed)) result.port = parsed;
  }
  return result;
}

export function loadNimbusLanFromPath(tomlPath: string): NimbusLanToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_LAN_TOML, parseNimbusLanToml);
}

export function loadNimbusLanFromConfigDir(configDir: string): NimbusLanToml {
  return loadNimbusLanFromPath(join(configDir, "nimbus.toml"));
}

/**
 * Runtime ids this build can actually execute. Config naming an unknown id drops it, rather than
 * carrying a name no registry can resolve all the way to a spawn attempt.
 */
export const KNOWN_EXEC_RUNTIMES = ["bun"] as const;

export type NimbusCodeExecutionToml = {
  enabled: boolean;
  maxWallClockMs: number;
  maxOutputBytes: number;
  allowedRuntimes: string[];
};

/**
 * DEFAULT OFF. With `enabled = false` the exec gate refuses before it ever reaches consent, so a
 * fresh install has no arbitrary-code-execution path at all and the capability's existence cannot
 * be probed by triggering a consent prompt.
 */
export const DEFAULT_NIMBUS_CODE_EXECUTION_TOML: NimbusCodeExecutionToml = {
  enabled: false,
  maxWallClockMs: 30_000,
  maxOutputBytes: 1_048_576,
  allowedRuntimes: ["bun"],
};

/**
 * Normalise to lowercase and drop unknown ids.
 *
 * The lowercasing is load-bearing, not cosmetic: the exec gate compares this array against the
 * runtime registry's own lowercase id, so if this stopped normalising, `allowed_runtimes = ["Bun"]`
 * would silently refuse every execution.
 */
function parseAllowedRuntimes(valRaw: string): string[] {
  const known = new Set<string>(KNOWN_EXEC_RUNTIMES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of parseStringArray(valRaw)) {
    const id = v.trim().toLowerCase();
    if (id === "" || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function applyNimbusCodeExecutionKey(
  out: Partial<NimbusCodeExecutionToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "max_wall_clock_ms": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxWallClockMs = n;
      break;
    }
    case "max_output_bytes": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.maxOutputBytes = n;
      break;
    }
    case "allowed_runtimes":
      out.allowedRuntimes = parseAllowedRuntimes(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlCodeExecutionSection(source: string): Partial<NimbusCodeExecutionToml> {
  const out: Partial<NimbusCodeExecutionToml> = {};
  forEachSectionEntry(source, "[code_execution]", (key, valRaw) => {
    applyNimbusCodeExecutionKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusCodeExecutionToml(
  raw: string,
  defaults: NimbusCodeExecutionToml = DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
): NimbusCodeExecutionToml {
  return { ...defaults, ...parseNimbusTomlCodeExecutionSection(raw) };
}

export function loadNimbusCodeExecutionFromPath(tomlPath: string): NimbusCodeExecutionToml {
  return loadTomlSection(
    tomlPath,
    DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
    parseNimbusCodeExecutionToml,
  );
}

export function loadNimbusCodeExecutionFromConfigDir(configDir: string): NimbusCodeExecutionToml {
  return loadNimbusCodeExecutionFromPath(join(configDir, "nimbus.toml"));
}

export const KNOWN_CU_LANES = ["browser", "terminal", "screen"] as const;
export type CuLane = (typeof KNOWN_CU_LANES)[number];

export type NimbusComputerUseToml = {
  enabled: boolean;
  allowedLanes: CuLane[];
  maxActions: number;
  maxWallClockMs: number;
  browserProfileDir: string;
  snapshotMaxBytes: number;
  snapshotRetentionDays: number;
};

/**
 * DEFAULT OFF, and `allowedLanes` DEFAULT EMPTY — a deliberate SECOND lock, and a departure from
 * `[code_execution]`'s non-empty `allowed_runtimes = ["bun"]`. `enabled = true` on its own actuates
 * nothing; the operator must name each lane. The screen lane costs `nimbus prove` its verdict for
 * any window containing one action, so opting into a lane should be an act rather than something
 * inherited from flipping one boolean.
 */
export const DEFAULT_NIMBUS_COMPUTER_USE_TOML: NimbusComputerUseToml = {
  enabled: false,
  allowedLanes: [],
  maxActions: 50,
  maxWallClockMs: 300_000,
  browserProfileDir: "",
  snapshotMaxBytes: 262_144,
  snapshotRetentionDays: 7,
};

/**
 * Normalise to lowercase and drop unknown lanes. The lowercasing is load-bearing: the gate compares
 * this array against the lane literal, so if this stopped normalising, `allowed_lanes = ["Browser"]`
 * would silently refuse every session with a message about the lane not being allowed.
 */
function parseAllowedLanes(valRaw: string): CuLane[] {
  const known = new Set<string>(KNOWN_CU_LANES);
  const seen = new Set<string>();
  const out: CuLane[] = [];
  for (const v of parseStringArray(valRaw)) {
    const id = v.trim().toLowerCase();
    if (id === "" || seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id as CuLane);
  }
  return out;
}

function applyNimbusComputerUseKey(
  out: Partial<NimbusComputerUseToml>,
  key: string,
  valRaw: string,
): void {
  const positive = (assign: (n: number) => void): void => {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) assign(n);
  };
  switch (key) {
    case "enabled":
      out.enabled = valRaw.trim().toLowerCase() === "true";
      break;
    case "allowed_lanes":
      out.allowedLanes = parseAllowedLanes(valRaw);
      break;
    case "max_actions":
      positive((n) => {
        out.maxActions = n;
      });
      break;
    case "max_wall_clock_ms":
      positive((n) => {
        out.maxWallClockMs = n;
      });
      break;
    case "browser_profile_dir":
      out.browserProfileDir = parseString(valRaw);
      break;
    case "snapshot_max_bytes":
      positive((n) => {
        out.snapshotMaxBytes = n;
      });
      break;
    case "snapshot_retention_days":
      positive((n) => {
        out.snapshotRetentionDays = n;
      });
      break;
    default:
      break;
  }
}

export function parseNimbusComputerUseToml(
  raw: string,
  defaults: NimbusComputerUseToml = DEFAULT_NIMBUS_COMPUTER_USE_TOML,
): NimbusComputerUseToml {
  const out: Partial<NimbusComputerUseToml> = {};
  forEachSectionEntry(raw, "[computer_use]", (key, valRaw) => {
    applyNimbusComputerUseKey(out, key, valRaw);
  });
  return { ...defaults, ...out };
}

export function loadNimbusComputerUseFromConfigDir(configDir: string): NimbusComputerUseToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_COMPUTER_USE_TOML,
    parseNimbusComputerUseToml,
  );
}

export type NimbusFederationToml = {
  enabled: boolean;
  consentTimeoutSeconds: number;
  mdnsEnabled: boolean;
  mdnsBind: string;
};

export const DEFAULT_NIMBUS_FEDERATION_TOML: NimbusFederationToml = {
  enabled: false,
  consentTimeoutSeconds: 30,
  mdnsEnabled: true,
  mdnsBind: "0.0.0.0",
};

function applyNimbusFederationKey(
  out: Partial<NimbusFederationToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "consent_timeout_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0 && n <= 3600) out.consentTimeoutSeconds = n;
      break;
    }
    case "mdns_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.mdnsEnabled = b;
      break;
    }
    case "mdns_bind":
      out.mdnsBind = parseString(valRaw);
      break;
    default:
      break;
  }
}

function parseNimbusTomlFederationSection(source: string): Partial<NimbusFederationToml> {
  const out: Partial<NimbusFederationToml> = {};
  forEachSectionEntry(source, "[federation]", (key, valRaw) => {
    applyNimbusFederationKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusFederationToml(
  raw: string,
  defaults: NimbusFederationToml = DEFAULT_NIMBUS_FEDERATION_TOML,
): NimbusFederationToml {
  const section = parseNimbusTomlFederationSection(raw);
  return { ...defaults, ...section };
}

export function loadNimbusFederationFromPath(tomlPath: string): NimbusFederationToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_FEDERATION_TOML, parseNimbusFederationToml);
}

export function loadNimbusFederationFromConfigDir(configDir: string): NimbusFederationToml {
  return loadNimbusFederationFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusAutomationToml = {
  graphConditions: boolean;
};

export const DEFAULT_NIMBUS_AUTOMATION_TOML: NimbusAutomationToml = {
  graphConditions: true,
};

function parseNimbusTomlAutomationSection(source: string): Partial<NimbusAutomationToml> {
  const out: Partial<NimbusAutomationToml> = {};
  forEachSectionEntry(source, "[automation]", (key, valRaw) => {
    if (key === "graph_conditions") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.graphConditions = b;
    }
  });
  return out;
}

export function parseNimbusAutomationToml(
  raw: string,
  defaults: NimbusAutomationToml = DEFAULT_NIMBUS_AUTOMATION_TOML,
): NimbusAutomationToml {
  return { ...defaults, ...parseNimbusTomlAutomationSection(raw) };
}

export function loadNimbusAutomationFromPath(tomlPath: string): NimbusAutomationToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AUTOMATION_TOML, parseNimbusAutomationToml);
}

export function loadNimbusAutomationFromConfigDir(configDir: string): NimbusAutomationToml {
  return loadNimbusAutomationFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusExtensionsToml = {
  updateCheckIntervalHours: number;
};

export const DEFAULT_NIMBUS_EXTENSIONS_TOML: NimbusExtensionsToml = {
  updateCheckIntervalHours: 24,
};

function parseUpdateCheckIntervalHours(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(
      `[extensions].update_check_interval_hours must be an integer (got: ${valRaw})`,
    );
  }
  if (n < 1 || n > 168) {
    throw new Error(`[extensions].update_check_interval_hours must be in [1, 168] (got: ${n})`);
  }
  return n;
}

function parseNimbusTomlExtensionsSection(source: string): Partial<NimbusExtensionsToml> {
  const out: Partial<NimbusExtensionsToml> = {};
  forEachSectionEntry(source, "[extensions]", (key, valRaw) => {
    if (key === "update_check_interval_hours") {
      out.updateCheckIntervalHours = parseUpdateCheckIntervalHours(valRaw);
    }
  });
  return out;
}

export function parseNimbusExtensionsToml(
  raw: string,
  defaults: NimbusExtensionsToml = DEFAULT_NIMBUS_EXTENSIONS_TOML,
): NimbusExtensionsToml {
  return { ...defaults, ...parseNimbusTomlExtensionsSection(raw) };
}

export function loadNimbusExtensionsFromPath(tomlPath: string): NimbusExtensionsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_EXTENSIONS_TOML, parseNimbusExtensionsToml);
}

export function loadNimbusExtensionsFromConfigDir(configDir: string): NimbusExtensionsToml {
  return loadNimbusExtensionsFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusAuditToml = {
  // 0 disables pruning (rows kept forever). > 0 = delete tool_call_log rows
  // older than N days on the daily retention job.
  toolCallLogRetentionDays: number;
};

export const DEFAULT_NIMBUS_AUDIT_TOML: NimbusAuditToml = {
  toolCallLogRetentionDays: 90,
};

function parseToolCallLogRetentionDays(valRaw: string): number {
  const n = Number(valRaw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new TypeError(`[audit].tool_call_log_retention_days must be an integer (got: ${valRaw})`);
  }
  if (n < 0 || n > 36_500) {
    throw new Error(`[audit].tool_call_log_retention_days must be in [0, 36500] (got: ${n})`);
  }
  return n;
}

function parseNimbusTomlAuditSection(source: string): Partial<NimbusAuditToml> {
  const out: Partial<NimbusAuditToml> = {};
  forEachSectionEntry(source, "[audit]", (key, valRaw) => {
    if (key === "tool_call_log_retention_days") {
      out.toolCallLogRetentionDays = parseToolCallLogRetentionDays(valRaw);
    }
  });
  return out;
}

export function parseNimbusAuditToml(
  raw: string,
  defaults: NimbusAuditToml = DEFAULT_NIMBUS_AUDIT_TOML,
): NimbusAuditToml {
  return { ...defaults, ...parseNimbusTomlAuditSection(raw) };
}

export function loadNimbusAuditFromPath(tomlPath: string): NimbusAuditToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AUDIT_TOML, parseNimbusAuditToml);
}

export function loadNimbusAuditFromConfigDir(configDir: string): NimbusAuditToml {
  return loadNimbusAuditFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusSecurityToml = {
  extendedPatterns: boolean;
  allowlistFingerprints: string[];
};

export const DEFAULT_NIMBUS_SECURITY_TOML: NimbusSecurityToml = {
  extendedPatterns: false,
  allowlistFingerprints: [],
};

function parseNimbusTomlSecuritySection(source: string): Partial<NimbusSecurityToml> {
  const out: Partial<NimbusSecurityToml> = {};
  forEachSectionEntry(source, "[security]", (key, valRaw) => {
    if (key === "extended_patterns") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.extendedPatterns = b;
    }
  });
  // [[security.allowlist]] is an array-of-tables; collect each entry's fingerprint.
  const fps: string[] = [];
  let inAllow = false;
  for (const line of source.split(/\r?\n/)) {
    const t = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (t === "") continue;
    if (isTableHeader(t)) {
      inAllow = t === "[[security.allowlist]]";
      continue;
    }
    if (!inAllow) continue;
    const kv = splitKeyValue(t);
    if (kv?.key === "fingerprint") {
      const v = parseString(kv.valRaw);
      if (v.length > 0) fps.push(v);
    }
  }
  if (fps.length > 0) out.allowlistFingerprints = fps;
  return out;
}

export function parseNimbusSecurityToml(
  raw: string,
  defaults: NimbusSecurityToml = DEFAULT_NIMBUS_SECURITY_TOML,
): NimbusSecurityToml {
  return { ...defaults, ...parseNimbusTomlSecuritySection(raw) };
}

export function loadNimbusSecurityFromPath(tomlPath: string): NimbusSecurityToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_SECURITY_TOML, parseNimbusSecurityToml);
}

export function loadNimbusSecurityFromConfigDir(configDir: string): NimbusSecurityToml {
  return loadNimbusSecurityFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusUserToml = {
  mePersonId?: string;
};

export const DEFAULT_NIMBUS_USER_TOML: NimbusUserToml = {};

function parseNimbusTomlUserSection(source: string): Partial<NimbusUserToml> {
  const out: Partial<NimbusUserToml> = {};
  forEachSectionEntry(source, "[user]", (key, valRaw) => {
    if (key === "me_person_id") {
      const v = parseString(valRaw);
      if (v.length > 0) out.mePersonId = v;
    }
  });
  return out;
}

export function parseNimbusUserToml(
  raw: string,
  defaults: NimbusUserToml = DEFAULT_NIMBUS_USER_TOML,
): NimbusUserToml {
  return { ...defaults, ...parseNimbusTomlUserSection(raw) };
}

export function loadNimbusUserFromPath(tomlPath: string): NimbusUserToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_USER_TOML, parseNimbusUserToml);
}

export function loadNimbusUserFromConfigDir(configDir: string): NimbusUserToml {
  return loadNimbusUserFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusPagerdutyToml = {
  maxPagesPerSync: number;
  severityP1Aliases: readonly string[];
};

export const DEFAULT_NIMBUS_PAGERDUTY_TOML: NimbusPagerdutyToml = {
  maxPagesPerSync: 20,
  severityP1Aliases: [],
};

function parseMaxPagesPerSync(valRaw: string): number {
  const n = parseIntDec(valRaw);
  if (n === undefined || n < 1 || n > 100) {
    throw new Error(`[pagerduty].max_pages_per_sync must be an integer in 1..100, got '${valRaw}'`);
  }
  return n;
}

function parseSeverityP1Aliases(valRaw: string): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];
  for (const v of parseStringArray(valRaw)) {
    const lower = v.trim().toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    collected.push(lower);
  }
  return collected;
}

function parseNimbusPagerdutySection(source: string): Partial<NimbusPagerdutyToml> {
  const out: { maxPagesPerSync?: number; severityP1Aliases?: readonly string[] } = {};
  forEachSectionEntry(source, "[pagerduty]", (key, valRaw) => {
    if (key === "max_pages_per_sync") {
      out.maxPagesPerSync = parseMaxPagesPerSync(valRaw);
    } else if (key === "severity_p1_aliases") {
      out.severityP1Aliases = parseSeverityP1Aliases(valRaw);
    }
  });
  return out;
}

export function parseNimbusPagerdutyToml(
  raw: string,
  defaults: NimbusPagerdutyToml = DEFAULT_NIMBUS_PAGERDUTY_TOML,
): NimbusPagerdutyToml {
  return { ...defaults, ...parseNimbusPagerdutySection(raw) };
}

export function loadNimbusPagerdutyFromPath(tomlPath: string): NimbusPagerdutyToml {
  if (!existsSync(tomlPath)) {
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  let raw: string;
  try {
    raw = readFileSync(tomlPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `nimbus: could not read [pagerduty] config at ${tomlPath}, using defaults: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
  try {
    return parseNimbusPagerdutyToml(raw);
  } catch (err) {
    process.stderr.write(
      `nimbus: [pagerduty] config in ${tomlPath} rejected, using defaults: ` +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    return structuredClone(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  }
}

export function loadNimbusPagerdutyFromConfigDir(configDir: string): NimbusPagerdutyToml {
  return loadNimbusPagerdutyFromPath(join(configDir, "nimbus.toml"));
}

export type NimbusIdentityToml = {
  enabled: boolean;
  issuer: string;
  clientId: string;
  flow: "device_code";
  scopes: string[];
  sessionGraceSeconds: number;
  revalidateIntervalSeconds: number;
  tokenRefreshSkewSeconds: number;
  jwksMaxAgeSeconds: number;
};

export const DEFAULT_NIMBUS_IDENTITY_TOML: NimbusIdentityToml = {
  enabled: false,
  issuer: "",
  clientId: "",
  flow: "device_code",
  scopes: ["openid", "email", "profile"],
  sessionGraceSeconds: 86400,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};

/** Maps a `[identity]` numeric key to its target field + minimum-accepted value. */
const NIMBUS_IDENTITY_NUMERIC_KEYS: Readonly<
  Record<string, { field: keyof NimbusIdentityToml; min: number }>
> = {
  session_grace_seconds: { field: "sessionGraceSeconds", min: 0 },
  revalidate_interval_seconds: { field: "revalidateIntervalSeconds", min: 1 },
  token_refresh_skew_seconds: { field: "tokenRefreshSkewSeconds", min: 0 },
  jwks_max_age_seconds: { field: "jwksMaxAgeSeconds", min: 1 },
};

/** Applies a numeric `[identity]` key. Returns true if `key` was a recognized numeric key. */
function applyNimbusIdentityNumericKey(
  out: Partial<NimbusIdentityToml>,
  key: string,
  valRaw: string,
): boolean {
  const spec = NIMBUS_IDENTITY_NUMERIC_KEYS[key];
  if (spec === undefined) return false;
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= spec.min) {
    (out[spec.field] as number) = n;
  }
  return true;
}

function applyNimbusIdentityKey(
  out: Partial<NimbusIdentityToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "issuer":
      out.issuer = parseString(valRaw);
      break;
    case "client_id":
      out.clientId = parseString(valRaw);
      break;
    case "scopes": {
      const arr = parseStringArray(valRaw).filter((s) => s.length > 0);
      if (arr.length > 0) out.scopes = arr;
      break;
    }
    default:
      applyNimbusIdentityNumericKey(out, key, valRaw);
      break;
  }
}

export function parseNimbusIdentityToml(
  raw: string,
  defaults: NimbusIdentityToml = DEFAULT_NIMBUS_IDENTITY_TOML,
): NimbusIdentityToml {
  const out: Partial<NimbusIdentityToml> = {};
  forEachSectionEntry(raw, "[identity]", (key, valRaw) => applyNimbusIdentityKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusIdentityFromConfigDir(configDir: string): NimbusIdentityToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_IDENTITY_TOML,
    parseNimbusIdentityToml,
  );
}

// ---------------------------------------------------------------------------
// [hitl.quorum] — per-action-type quorum rules
// ---------------------------------------------------------------------------

export interface QuorumRule {
  readonly approvers: number;
  readonly windowSeconds: number;
}

export type QuorumConfig = ReadonlyMap<string, QuorumRule>;

const HITL_QUORUM_TABLE_PREFIX = '[hitl.quorum."';

/**
 * Parse the `[hitl.quorum."<action-type>"]` sub-tables from a raw nimbus.toml
 * string into a QuorumConfig map.
 *
 * Each sub-table must have:
 *   approvers    = <integer >= 1>
 *   window_seconds = <integer > 0>
 *
 * Malformed rows (missing/non-numeric values, approvers < 1, window <= 0) are
 * silently ignored. Returns an empty map when the section is absent (quorum off).
 */
export function parseQuorumConfig(source: string): QuorumConfig {
  const out = new Map<string, QuorumRule>();
  for (const [actionType, kv] of collectQuorumKvSections(source).entries()) {
    const rule = toQuorumRule(kv);
    if (rule !== undefined) out.set(actionType, rule);
  }
  return out;
}

/** Accumulates raw kv strings per `[hitl.quorum."<action-type>"]` sub-table. */
function collectQuorumKvSections(source: string): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      currentId = beginQuorumTable(accum, trimmed);
      continue;
    }
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/**
 * If `trimmed` is a `[hitl.quorum."<action-type>"]` header with a non-empty id,
 * ensures a bucket exists in `accum` and returns the id; otherwise returns undefined.
 */
function beginQuorumTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
): string | undefined {
  if (!trimmed.startsWith(HITL_QUORUM_TABLE_PREFIX) || !trimmed.endsWith('"]')) return undefined;
  const id = trimmed.slice(HITL_QUORUM_TABLE_PREFIX.length, -2);
  if (id.length === 0) return undefined;
  if (!accum.has(id)) accum.set(id, {});
  return id;
}

/**
 * Records a `key = value` line into the current sub-table's bucket, if any.
 *
 * ONE definition for every `[<section>.<id>]` sub-table parser in this file — `[llm.local.*]`,
 * `[hitl.quorum."*"]` and the rest all accumulate raw kv strings identically, and a second copy of
 * these four lines is a second place for "a line outside any table is DROPPED, never misfiled into
 * the previous table" to drift.
 */
function applyKvLine(bucket: Record<string, string> | undefined, trimmed: string): void {
  if (bucket === undefined) return;
  const kv = splitKeyValue(trimmed);
  if (kv !== undefined) bucket[kv.key] = kv.valRaw;
}

/**
 * Validates one sub-table's raw kv strings into a QuorumRule, or undefined when
 * malformed (missing/non-numeric values, approvers < 1, window_seconds <= 0).
 */
function toQuorumRule(kv: Record<string, string>): QuorumRule | undefined {
  const approversRaw = kv["approvers"];
  const windowRaw = kv["window_seconds"];
  if (approversRaw === undefined || windowRaw === undefined) return undefined;
  const approvers = parseIntDec(approversRaw);
  const windowSeconds = parseIntDec(windowRaw);
  if (approvers === undefined || windowSeconds === undefined) return undefined;
  if (approvers < 1 || windowSeconds <= 0) return undefined;
  return { approvers, windowSeconds };
}

export function loadNimbusQuorumFromPath(tomlPath: string): QuorumConfig {
  return loadTomlSection<QuorumConfig>(tomlPath, new Map(), parseQuorumConfig);
}

export function loadNimbusQuorumFromConfigDir(configDir: string): QuorumConfig {
  return loadNimbusQuorumFromPath(join(configDir, "nimbus.toml"));
}

// ---------------------------------------------------------------------------

export type NimbusScimToml = { enabled: boolean };
export const DEFAULT_NIMBUS_SCIM_TOML: NimbusScimToml = { enabled: false };

export function parseNimbusScimToml(
  raw: string,
  defaults: NimbusScimToml = DEFAULT_NIMBUS_SCIM_TOML,
): NimbusScimToml {
  const out: Partial<NimbusScimToml> = {};
  forEachSectionEntry(raw, "[scim]", (key, valRaw) => {
    if (key === "enabled") {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
    }
  });
  return { ...defaults, ...out };
}

export function loadNimbusScimFromConfigDir(configDir: string): NimbusScimToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_SCIM_TOML,
    parseNimbusScimToml,
  );
}

// ---------------------------------------------------------------------------
// [chatops] — ChatOps bridge (Phase 6 Slice 5)
// ---------------------------------------------------------------------------

export type NimbusChatopsToml = {
  enabled: boolean;
  slackEnabled: boolean;
  teamsEnabled: boolean;
  /** Team Vault entry name holding the bot tokens (Slice 2). */
  botVaultEntry: string;
  /** TTL for the platform-userId -> email mapping cache (authz is always re-checked live). */
  identityCacheTtlSeconds: number;
  /** Teams bot app id; the `aud` claim the Bot Framework JWT must carry. */
  teamsBotAppId: string;
};

export const DEFAULT_NIMBUS_CHATOPS_TOML: NimbusChatopsToml = {
  enabled: false,
  slackEnabled: false,
  teamsEnabled: false,
  botVaultEntry: "chatops-bot",
  identityCacheTtlSeconds: 900,
  teamsBotAppId: "",
};

function applyNimbusChatopsKey(out: Partial<NimbusChatopsToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "slack_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.slackEnabled = b;
      break;
    }
    case "teams_enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.teamsEnabled = b;
      break;
    }
    case "bot_vault_entry":
      out.botVaultEntry = parseString(valRaw);
      break;
    case "teams_bot_app_id":
      out.teamsBotAppId = parseString(valRaw);
      break;
    case "identity_cache_ttl_seconds": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out.identityCacheTtlSeconds = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusChatopsToml(
  raw: string,
  defaults: NimbusChatopsToml = DEFAULT_NIMBUS_CHATOPS_TOML,
): NimbusChatopsToml {
  const out: Partial<NimbusChatopsToml> = {};
  forEachSectionEntry(raw, "[chatops]", (key, valRaw) => applyNimbusChatopsKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusChatopsFromConfigDir(configDir: string): NimbusChatopsToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_CHATOPS_TOML,
    parseNimbusChatopsToml,
  );
}

// ---------------------------------------------------------------------------
// [federation.preflight."<namespace>"] — per-namespace downstream preflight command (I24)
// ---------------------------------------------------------------------------

export interface PreflightCommandConfig {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
}

export type PreflightConfig = ReadonlyMap<string, PreflightCommandConfig>;

const PREFLIGHT_TABLE_PREFIX = '[federation.preflight."';
const PREFLIGHT_TIMEOUT_DEFAULT = 300;
const PREFLIGHT_TIMEOUT_CAP = 1800;

/** Accumulates raw kv strings per `[federation.preflight."<namespace>"]` sub-table. */
function collectPreflightKvSections(source: string): Map<string, Record<string, string>> {
  const accum = new Map<string, Record<string, string>>();
  let currentId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    // A line whose quoted value never closes is malformed. Skipping beats
    // acting on the mangled value the old parser produced (a leading `"` plus
    // a truncated fragment) — no value is better than a wrong one.
    if (hasUnterminatedString(line)) continue;
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      currentId = beginPreflightTable(accum, trimmed);
      continue;
    }
    if (currentId === undefined) continue;
    applyKvLine(accum.get(currentId), trimmed);
  }

  return accum;
}

/**
 * If `trimmed` is a `[federation.preflight."<namespace>"]` header with a non-empty id,
 * ensures a bucket exists in `accum` and returns the id; otherwise returns undefined.
 */
function beginPreflightTable(
  accum: Map<string, Record<string, string>>,
  trimmed: string,
): string | undefined {
  if (!trimmed.startsWith(PREFLIGHT_TABLE_PREFIX) || !trimmed.endsWith('"]')) return undefined;
  const id = trimmed.slice(PREFLIGHT_TABLE_PREFIX.length, -2);
  if (id.length === 0) return undefined;
  if (!accum.has(id)) accum.set(id, {});
  return id;
}

/**
 * Converts one sub-table's raw kv strings into a PreflightCommandConfig, or undefined when
 * no `command` key is present or it is empty (command-less tables are ignored).
 */
function toPreflightCommandConfig(kv: Record<string, string>): PreflightCommandConfig | undefined {
  const commandRaw = kv["command"];
  if (commandRaw === undefined) return undefined;
  const command = parseString(commandRaw);
  if (command.length === 0) return undefined;
  const timeoutParsed =
    kv["timeout_seconds"] === undefined ? undefined : parseIntDec(kv["timeout_seconds"]);
  const timeoutSeconds =
    timeoutParsed === undefined || timeoutParsed <= 0
      ? PREFLIGHT_TIMEOUT_DEFAULT
      : Math.min(timeoutParsed, PREFLIGHT_TIMEOUT_CAP);
  return {
    command,
    args: kv["args"] === undefined ? [] : parseStringArray(kv["args"]),
    cwd: kv["cwd"] === undefined ? "." : parseString(kv["cwd"]),
    timeoutSeconds,
  };
}

export function parsePreflightConfig(source: string): PreflightConfig {
  const out = new Map<string, PreflightCommandConfig>();
  for (const [ns, kv] of collectPreflightKvSections(source).entries()) {
    const cfg = toPreflightCommandConfig(kv);
    if (cfg !== undefined) out.set(ns, cfg);
  }
  return out;
}

export function loadNimbusPreflightFromConfigDir(configDir: string): PreflightConfig {
  return loadTomlSection<PreflightConfig>(
    join(configDir, "nimbus.toml"),
    new Map(),
    parsePreflightConfig,
  );
}

// ---------------------------------------------------------------------------
// [tribal] — tribal-knowledge extraction (Phase 6 Slice 6c)
// ---------------------------------------------------------------------------

export type TribalMatchMode = "embedding" | "embedding+llm";

export type TribalNotionTarget = { databaseId: string };

export type TribalConfluenceTarget = { spaceKey: string; parentPageId: string };

export type NimbusTribalToml = {
  enabled: boolean;
  match: TribalMatchMode;
  minOccurrences: number;
  windowDays: number;
  cooldownDays: number;
  watchChannels: readonly string[];
  notion?: TribalNotionTarget;
  confluence?: TribalConfluenceTarget;
};

export const DEFAULT_NIMBUS_TRIBAL_TOML: NimbusTribalToml = {
  enabled: false,
  match: "embedding",
  minOccurrences: 3,
  windowDays: 14,
  cooldownDays: 30,
  watchChannels: [],
};

/** Parse an integer kv value with a minimum floor; returns undefined when absent/non-numeric/below `min`. */
function parseIntWithMin(valRaw: string, min: number): number | undefined {
  const n = parseIntDec(valRaw);
  return n !== undefined && n >= min ? n : undefined;
}

/** Apply one `[tribal]` key/value to the accumulator (silently ignores malformed/unknown entries). */
function applyTribalEntry(out: Partial<NimbusTribalToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      return;
    }
    case "match": {
      const v = parseString(valRaw);
      if (v === "embedding" || v === "embedding+llm") out.match = v;
      return;
    }
    case "min_occurrences": {
      const n = parseIntWithMin(valRaw, 1);
      if (n !== undefined) out.minOccurrences = n;
      return;
    }
    case "window_days": {
      const n = parseIntWithMin(valRaw, 1);
      if (n !== undefined) out.windowDays = n;
      return;
    }
    case "cooldown_days": {
      const n = parseIntWithMin(valRaw, 0);
      if (n !== undefined) out.cooldownDays = n;
      return;
    }
    case "watch_channels": {
      try {
        out.watchChannels = parseStringArray(valRaw);
      } catch {
        // malformed array — keep default
      }
      return;
    }
    default:
      return;
  }
}

function parseNimbusTomlTribalSection(source: string): Partial<NimbusTribalToml> {
  const out: Partial<NimbusTribalToml> = {};
  forEachSectionEntry(source, "[tribal]", (key, valRaw) => {
    applyTribalEntry(out, key, valRaw);
  });
  return out;
}

function parseTribalNotionTarget(source: string): TribalNotionTarget | undefined {
  let databaseId: string | undefined;
  forEachSectionEntry(source, "[tribal.notion]", (key, valRaw) => {
    if (key === "database_id") {
      const v = parseString(valRaw);
      if (v.length > 0) databaseId = v;
    }
  });
  return databaseId === undefined ? undefined : { databaseId };
}

function parseTribalConfluenceTarget(source: string): TribalConfluenceTarget | undefined {
  let spaceKey: string | undefined;
  let parentPageId: string | undefined;
  forEachSectionEntry(source, "[tribal.confluence]", (key, valRaw) => {
    if (key === "space_key") {
      const v = parseString(valRaw);
      if (v.length > 0) spaceKey = v;
    } else if (key === "parent_page_id") {
      const v = parseString(valRaw);
      if (v.length > 0) parentPageId = v;
    }
  });
  return spaceKey !== undefined && parentPageId !== undefined
    ? { spaceKey, parentPageId }
    : undefined;
}

export function parseNimbusTribalToml(
  raw: string,
  defaults: NimbusTribalToml = DEFAULT_NIMBUS_TRIBAL_TOML,
): NimbusTribalToml {
  const section = parseNimbusTomlTribalSection(raw);
  const result: NimbusTribalToml = { ...defaults, ...section };
  const notion = parseTribalNotionTarget(raw);
  if (notion !== undefined) result.notion = notion;
  const confluence = parseTribalConfluenceTarget(raw);
  if (confluence !== undefined) result.confluence = confluence;
  return result;
}

export function loadNimbusTribalFromConfigDir(configDir: string): NimbusTribalToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_TRIBAL_TOML,
    parseNimbusTribalToml,
  );
}

// ---------------------------------------------------------------------------
// Share & Virality (Phase 6 Slice 8). `[share.http_sink]` is the config-pinned destination for the
// `--http` outbound-share sink (the only host it may POST to). The bearer token is Vault-only
// (Non-Negotiable #3): config holds ONLY the Vault key NAME (`auth_vault_key`), never the value. An
// empty/absent `url` leaves the http sink unconfigured → `share.create --http` fails closed.

export type NimbusShareHttpSink = {
  readonly url: string;
  readonly authHeaderName?: string;
  readonly authVaultKey?: string;
};

export const DEFAULT_NIMBUS_SHARE_HTTP_SINK: NimbusShareHttpSink = { url: "" };

export function parseNimbusShareHttpSink(raw: string): NimbusShareHttpSink {
  let url = "";
  let authHeaderName: string | undefined;
  let authVaultKey: string | undefined;
  forEachSectionEntry(raw, "[share.http_sink]", (key, valRaw) => {
    if (key === "url") {
      const v = parseString(valRaw);
      if (v.length > 0) url = v;
    } else if (key === "auth_header_name") {
      const v = parseString(valRaw);
      if (v.length > 0) authHeaderName = v;
    } else if (key === "auth_vault_key") {
      const v = parseString(valRaw);
      if (v.length > 0) authVaultKey = v;
    }
  });
  return {
    url,
    ...(authHeaderName === undefined ? {} : { authHeaderName }),
    ...(authVaultKey === undefined ? {} : { authVaultKey }),
  };
}

export function loadNimbusShareHttpSink(configDir: string): NimbusShareHttpSink {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_SHARE_HTTP_SINK,
    parseNimbusShareHttpSink,
  );
}

// ---------------------------------------------------------------------------
// [briefs] — research briefs (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusBriefsToml = {
  /** Default OFF: briefs are the first surface that can send user content to a remote model. */
  enabled: boolean;
  /** Route synthesis to a local provider when one is available. */
  preferLocal: boolean;
  ttlMinutes: number;
};

export const DEFAULT_NIMBUS_BRIEFS_TOML: NimbusBriefsToml = {
  enabled: false,
  preferLocal: true,
  ttlMinutes: 30,
};

function applyNimbusBriefsKey(out: Partial<NimbusBriefsToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "prefer_local": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.preferLocal = b;
      break;
    }
    case "ttl_minutes": {
      const n = parseIntDec(valRaw);
      if (n !== undefined && n > 0) out.ttlMinutes = n;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusBriefsToml(
  raw: string,
  defaults: NimbusBriefsToml = DEFAULT_NIMBUS_BRIEFS_TOML,
): NimbusBriefsToml {
  const out: Partial<NimbusBriefsToml> = {};
  forEachSectionEntry(raw, "[briefs]", (key, valRaw) => applyNimbusBriefsKey(out, key, valRaw));
  return { ...defaults, ...out };
}

// The assemble consumer reads from a path — mirror the existing loadNimbus<X>FromPath
// helpers (there is NO `readActiveTomlRaw`; `loadTomlSection` is the real primitive and
// already handles a missing file / parse error by returning the defaults).
export function loadNimbusBriefsFromPath(tomlPath: string): NimbusBriefsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_BRIEFS_TOML, (raw) => parseNimbusBriefsToml(raw));
}

// ---------------------------------------------------------------------------
// [glossary] — implicit-knowledge glossary (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusGlossaryToml = {
  /**
   * Default ON, unlike [briefs]. Briefs open an HTTP write surface; the
   * glossary opens nothing — it reads the local index and writes local rows.
   */
  enabled: boolean;
  /**
   * Consolidate via a LOCAL model. Default on, but separable from `enabled`:
   * turning this off keeps the cheap snippet glossary while sparing a laptop
   * up to `max_new_terms_per_pass` sequential local-model calls per sync burst.
   */
  useLlm: boolean;
  /** LLM calls per pass (sequential). */
  maxNewTermsPerPass: number;
  /** Reconciliation sweep width — pure SQL, no LLM cost. */
  statsRecheckPerPass: number;
  /** Skip re-verifying a term checked more recently than this (default 12 h). */
  statsRecheckCooldownMs: number;
  minDocFreq: number;
  debounceMs: number;
  consolidateTimeoutMs: number;
  /** Base for the exponential retry backoff that prevents queue starvation. */
  retryBaseCooldownMs: number;
};

export const DEFAULT_NIMBUS_GLOSSARY_TOML: NimbusGlossaryToml = {
  enabled: true,
  useLlm: true,
  maxNewTermsPerPass: 25,
  statsRecheckPerPass: 50,
  statsRecheckCooldownMs: 12 * 60 * 60 * 1000,
  minDocFreq: 3,
  debounceMs: 60000,
  consolidateTimeoutMs: 30000,
  retryBaseCooldownMs: 15 * 60 * 1000,
};

function applyNimbusGlossaryKey(
  out: Partial<NimbusGlossaryToml>,
  key: string,
  valRaw: string,
): void {
  if (applyPassSectionToggle(out, key, valRaw)) return;
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "max_new_terms_per_pass":
      out.maxNewTermsPerPass = n;
      break;
    case "stats_recheck_per_pass":
      out.statsRecheckPerPass = n;
      break;
    case "stats_recheck_cooldown_ms":
      out.statsRecheckCooldownMs = n;
      break;
    case "retry_base_cooldown_ms":
      out.retryBaseCooldownMs = n;
      break;
    case "min_doc_freq":
      out.minDocFreq = n;
      break;
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "consolidate_timeout_ms":
      out.consolidateTimeoutMs = n;
      break;
    default:
      break;
  }
}

export function parseNimbusGlossaryToml(
  raw: string,
  defaults: NimbusGlossaryToml = DEFAULT_NIMBUS_GLOSSARY_TOML,
): NimbusGlossaryToml {
  const out: Partial<NimbusGlossaryToml> = {};
  forEachSectionEntry(raw, "[glossary]", (key, valRaw) => applyNimbusGlossaryKey(out, key, valRaw));
  return { ...defaults, ...out };
}

export function loadNimbusGlossaryFromConfigDir(configDir: string): NimbusGlossaryToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_GLOSSARY_TOML,
    parseNimbusGlossaryToml,
  );
}

// ---------------------------------------------------------------------------
// [decisions] — implicit decision extraction (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusDecisionsToml = {
  /**
   * Default ON, like [glossary] and unlike [briefs]: extraction opens no
   * network surface — it reads the local index and writes local rows.
   */
  enabled: boolean;
  /**
   * Extract via a LOCAL model. Default on, but separable from `enabled`:
   * turning this off keeps the cheap heuristic pass while sparing a laptop up
   * to `max_llm_calls_per_pass` sequential local-model calls per sync burst.
   */
  useLlm: boolean;
  /**
   * READ-path floor: `nimbus decisions` omits any stored decision scoring
   * below this when `--min-confidence` is not given. Clamped into 0..1.
   * Extraction stores everything regardless, so changing this re-filters an
   * existing store rather than needing a `--rebuild`.
   */
  minConfidence: number;
  /** LLM calls per pass (sequential). */
  maxLlmCallsPerPass: number;
  debounceMs: number;
  /** Cooldown before a failed extraction is retried (prevents starvation). */
  retryCooldownMs: number;
};

export const DEFAULT_NIMBUS_DECISIONS_TOML: NimbusDecisionsToml = {
  enabled: true,
  useLlm: true,
  minConfidence: 0.3,
  maxLlmCallsPerPass: 25,
  debounceMs: 30_000,
  retryCooldownMs: 60_000,
};

function applyNimbusDecisionsKey(
  out: Partial<NimbusDecisionsToml>,
  key: string,
  valRaw: string,
): void {
  // Bool keys MUST come before the integer branch below — same regression the
  // [glossary] block guards against: routed through `parseIntDec`, `use_llm`
  // is silently dropped and the section reads as if it were never set.
  if (applyPassSectionToggle(out, key, valRaw)) return;
  // `min_confidence` is the one FLOAT key, so it must precede the integer
  // branch too: that branch would truncate 0.7 to 0, and its `n <= 0` guard
  // would discard a negative before the clamp below ever saw it.
  if (key === "min_confidence") {
    const f = Number(valRaw.trim());
    if (valRaw.trim() !== "" && Number.isFinite(f)) {
      out.minConfidence = Math.min(1, Math.max(0, f));
    }
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "max_llm_calls_per_pass":
      out.maxLlmCallsPerPass = n;
      break;
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "retry_cooldown_ms":
      out.retryCooldownMs = n;
      break;
    default:
      break;
  }
}

export function parseNimbusDecisionsToml(
  raw: string,
  defaults: NimbusDecisionsToml = DEFAULT_NIMBUS_DECISIONS_TOML,
): NimbusDecisionsToml {
  const out: Partial<NimbusDecisionsToml> = {};
  forEachSectionEntry(raw, "[decisions]", (key, valRaw) =>
    applyNimbusDecisionsKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusDecisionsFromConfigDir(configDir: string): NimbusDecisionsToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_DECISIONS_TOML,
    parseNimbusDecisionsToml,
  );
}

// ---------------------------------------------------------------------------
// [ownership] — ownership graph derivation pass (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusOwnershipToml = {
  /** Default ON, like [glossary] and [decisions]. This pass opens nothing and
   * calls no model — it reads local rows and writes local graph edges. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** Recency half-life for blame-line weighting. */
  halfLifeDays: number;
  /** Minimum share for an edge to be emitted. FLOAT — see the parser. */
  minShare: number;
  /** Cap on emitted owners per path; the true count lands on entity metadata. */
  maxOwnersPerPath: number;
  /** Root-relative globs excluded from aggregation. `[]` disables filtering. */
  ignoreGlobs: string[];
};

/**
 * Lock files and generated output are fully present in `git_blame_line`:
 * `gitBlameWindowFiles` (`connectors/blame-index-sync.ts:70`) is a bare
 * `git log --name-only` and consults NO exclude list. Left unfiltered, a
 * churning lock file is thousands of lines credited to whoever last ran the
 * installer, and would dominate its directory's rollup.
 */
const DEFAULT_OWNERSHIP_IGNORE_GLOBS: readonly string[] = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/bun.lockb",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/Gemfile.lock",
  "**/composer.lock",
  "**/go.sum",
  "**/vendor/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.snap",
  "**/__snapshots__/**",
  "**/*.generated.*",
  "**/*.pb.go",
  "**/*_pb2.py",
];

export const DEFAULT_NIMBUS_OWNERSHIP_TOML: NimbusOwnershipToml = {
  enabled: true,
  debounceMs: 30_000,
  halfLifeDays: 365,
  minShare: 0.05,
  maxOwnersPerPath: 10,
  ignoreGlobs: [...DEFAULT_OWNERSHIP_IGNORE_GLOBS],
};

function applyNimbusOwnershipKey(
  out: Partial<NimbusOwnershipToml>,
  key: string,
  valRaw: string,
): void {
  // `applyEnabledToggle`, NOT `applyPassSectionToggle`: `[ownership]` has no `use_llm` key, and
  // the two-key helper would write one onto the returned config.
  if (applyEnabledToggle(out, key, valRaw)) return;
  if (key === "ignore_globs") {
    // `parseStringArray` THROWS a TypeError on anything not bracket-delimited.
    // Unguarded, that escapes `parseNimbusOwnershipToml` into `loadTomlSection`'s
    // catch, which discards the WHOLE `[ownership]` section — so one malformed
    // glob line would silently re-enable a pass the user had turned off with
    // `enabled = false`. Swallow it here instead: `ignoreGlobs` stays unset and
    // falls back to the default list, every other key in the section survives.
    try {
      // An explicit empty array is meaningful (disable filtering), so this must
      // NOT be guarded on length.
      out.ignoreGlobs = parseStringArray(valRaw);
    } catch {
      /* malformed: keep the default ignore list */
    }
    return;
  }
  // `min_share` is the one FLOAT key, so it MUST precede the integer branch:
  // that branch would truncate 0.05 to 0, and its `n <= 0` guard would then
  // discard it before the clamp ever ran — silently disabling the threshold.
  // Identical to the [decisions].min_confidence trap at lines 1663-1665.
  if (key === "min_share") {
    const f = Number(valRaw.trim());
    if (valRaw.trim() !== "" && Number.isFinite(f)) {
      out.minShare = Math.min(1, Math.max(0, f));
    }
    return;
  }
  const n = parseIntDec(valRaw);
  if (n === undefined || n <= 0) return;
  switch (key) {
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "half_life_days":
      out.halfLifeDays = n;
      break;
    case "max_owners_per_path":
      out.maxOwnersPerPath = n;
      break;
    default:
      break;
  }
}

export function parseNimbusOwnershipToml(
  raw: string,
  defaults: NimbusOwnershipToml = DEFAULT_NIMBUS_OWNERSHIP_TOML,
): NimbusOwnershipToml {
  const out: Partial<NimbusOwnershipToml> = {};
  forEachSectionEntry(raw, "[ownership]", (key, valRaw) =>
    applyNimbusOwnershipKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusOwnershipFromConfigDir(configDir: string): NimbusOwnershipToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_OWNERSHIP_TOML,
    parseNimbusOwnershipToml,
  );
}

// ---------------------------------------------------------------------------
// [premortem] — recurring blocker theme extraction pass (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusPremortemToml = {
  /** Default ON, like [glossary]/[decisions]/[ownership]. */
  enabled: boolean;
  /** Post-sync debounce. Matches [decisions]. */
  debounceMs: number;
  /** When false the pass runs but writes zero themes; structural risks are unaffected. */
  useLlm: boolean;
  /** Hard ceiling on model calls per pass. */
  maxLlmCallsPerPass: number;
  /** Cap on the cohort PR B assembles. */
  maxCohortSize: number;
  /** Cap on closed epics scanned for a service set before the cohort lane stops. */
  maxCandidateScan: number;
};

export const DEFAULT_NIMBUS_PREMORTEM_TOML: NimbusPremortemToml = {
  enabled: true,
  debounceMs: 60_000,
  useLlm: true,
  maxLlmCallsPerPass: 25,
  maxCohortSize: 10,
  maxCandidateScan: 200,
};

/**
 * A malformed or non-positive bound falls back to its default rather than
 * clamping to zero: `max_candidate_scan = 0` would yield an empty cohort that
 * reads as "no comparable epics ever closed", which is a wrong answer rather
 * than an empty one.
 */
function applyNimbusPremortemKey(
  out: Partial<NimbusPremortemToml>,
  key: string,
  valRaw: string,
): void {
  // Bool keys MUST come before the integer branch below — same regression the
  // [glossary] block guards against: routed through `parseIntDec`, `use_llm`
  // is silently dropped and the section reads as if it were never set.
  if (applyPassSectionToggle(out, key, valRaw)) return;
  const n = parseIntWithMin(valRaw, 1);
  if (n === undefined) return;
  switch (key) {
    case "debounce_ms":
      out.debounceMs = n;
      break;
    case "max_llm_calls_per_pass":
      out.maxLlmCallsPerPass = n;
      break;
    case "max_cohort_size":
      out.maxCohortSize = n;
      break;
    case "max_candidate_scan":
      out.maxCandidateScan = n;
      break;
    default:
      break;
  }
}

export function parseNimbusPremortemToml(
  raw: string,
  defaults: NimbusPremortemToml = DEFAULT_NIMBUS_PREMORTEM_TOML,
): NimbusPremortemToml {
  const out: Partial<NimbusPremortemToml> = {};
  forEachSectionEntry(raw, "[premortem]", (key, valRaw) =>
    applyNimbusPremortemKey(out, key, valRaw),
  );
  return { ...defaults, ...out };
}

export function loadNimbusPremortemFromConfigDir(configDir: string): NimbusPremortemToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_PREMORTEM_TOML,
    parseNimbusPremortemToml,
  );
}

// ---------------------------------------------------------------------------
// [negotiate] — personal-docs opt-in for the contribution-brief agent (Spine S1)
// ---------------------------------------------------------------------------

export type NimbusNegotiateToml = {
  /**
   * Personal sources (e.g. `obsidian`) are mined by `nimbus negotiate` only when named
   * here — configuration IS the consent (spec § 3.3, following the `[glossary.terms]`
   * precedent). Empty means work artifacts only.
   */
  personalSources: string[];
};

export const DEFAULT_NIMBUS_NEGOTIATE_TOML: NimbusNegotiateToml = { personalSources: [] };

/**
 * `parseStringArray` cannot distinguish a quoted TOML string from a bare token: an
 * unquoted `42` parses through as the literal string "42", with no quoting information
 * left to recover afterward. Such a bare numeric entry was never actually authored as a
 * string, so it is dropped here rather than reaching a query — fail-safe toward excluding
 * (Task 6 brief's two malformed-input rules).
 */
function isBareNumericToken(entry: string): boolean {
  const t = entry.trim();
  return t !== "" && Number.isFinite(Number(t));
}

/**
 * Blank and non-string (bare numeric) entries are dropped at parse time, never reaching
 * a query. A malformed (non-array) value falls back to an empty list rather than throwing.
 *
 * Entries are lower-cased because the consumer matches them against `item.service`, which is
 * always a lower-case connector id: `personal_sources = ["Obsidian"]` is a natural thing to
 * write in TOML, and matched nothing under an exact, case-sensitive comparison — an UNDERCOUNT
 * that `nimbus negotiate` then reported as configured coverage. Folding here rather than at the
 * comparison site keeps one normalisation point for every future consumer of the list.
 */
function parsePersonalSources(valRaw: string): string[] {
  try {
    return parseStringArray(valRaw)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0 && !isBareNumericToken(s));
  } catch {
    return [];
  }
}

function parseNimbusTomlNegotiateSection(source: string): Partial<NimbusNegotiateToml> {
  const out: Partial<NimbusNegotiateToml> = {};
  forEachSectionEntry(source, "[negotiate]", (key, valRaw) => {
    if (key === "personal_sources") {
      out.personalSources = parsePersonalSources(valRaw);
    }
  });
  return out;
}

export function parseNimbusNegotiateToml(
  raw: string,
  defaults: NimbusNegotiateToml = DEFAULT_NIMBUS_NEGOTIATE_TOML,
): NimbusNegotiateToml {
  return { ...defaults, ...parseNimbusTomlNegotiateSection(raw) };
}

export function loadNimbusNegotiateFromPath(tomlPath: string): NimbusNegotiateToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_NEGOTIATE_TOML, parseNimbusNegotiateToml);
}

export function loadNimbusNegotiateFromConfigDir(configDir: string): NimbusNegotiateToml {
  return loadNimbusNegotiateFromPath(join(configDir, "nimbus.toml"));
}

// ---------------------------------------------------------------------------
// [agents] — built-in agent brief synthesis (Spine S1, W6-A0)
// ---------------------------------------------------------------------------

export type SynthesisMode = "off" | "local" | "allow-remote";

export type NimbusAgentsToml = {
  /**
   * Default "local", NOT "allow-remote". "allow-remote" is the first path by which indexed
   * content can leave the machine without a connector being involved, so it is opt-in.
   */
  synthesis: SynthesisMode;
  /**
   * Deliberately generous. Briefs are fire-and-forget (emit-brief.ts:54 returns
   * before the work), so this does not gate a caller — it exists so a hung
   * provider yields a deterministic brief rather than a briefReady that never
   * arrives. A 3-5s value would reject every synthesis on a cold Ollama.
   */
  synthesisTimeoutMs: number;
};

export const DEFAULT_NIMBUS_AGENTS_TOML: NimbusAgentsToml = {
  synthesis: "local",
  synthesisTimeoutMs: 20000,
};

const SYNTHESIS_MODES: ReadonlySet<string> = new Set(["off", "local", "allow-remote"]);

function applyNimbusAgentsKey(out: NimbusAgentsToml, key: string, valRaw: string): void {
  if (key === "synthesis") {
    const v = valRaw.trim().replace(/^"|"$/g, "");
    // Unknown values fall back to the default. Never widen to "allow-remote" on a typo.
    if (SYNTHESIS_MODES.has(v)) out.synthesis = v as SynthesisMode;
    return;
  }
  if (key === "synthesis_timeout_ms") {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) out.synthesisTimeoutMs = n;
  }
}

export function parseNimbusAgentsToml(
  raw: string,
  defaults: NimbusAgentsToml = DEFAULT_NIMBUS_AGENTS_TOML,
): NimbusAgentsToml {
  const out: NimbusAgentsToml = { ...defaults };
  forEachSectionEntry(raw, "[agents]", (key, valRaw) => applyNimbusAgentsKey(out, key, valRaw));
  return out;
}

// ---------------------------------------------------------------------------
// [persona] — agent persona (Spine S1, W6-A2)
//
// Two knobs only. `tool_caution` and `confidence_threshold` from the original
// roadmap row are REJECTED, not deferred: Non-Negotiable #2 + I2 forbid a knob
// that loosens HITL, and a dial that makes the agent hedge less is the same
// mistake one layer up. See the design spec, D1.
// ---------------------------------------------------------------------------

export type PersonaTone = "neutral" | "terse" | "formal" | "casual" | "verbose";
export type PersonaVoice = "neutral" | "opinionated" | "collective";

export type NimbusPersonaToml = {
  tone: PersonaTone;
  voice: PersonaVoice;
};

/** Both `"neutral"` — the value that makes `applyPersona` the identity function. */
export const DEFAULT_NIMBUS_PERSONA_TOML: NimbusPersonaToml = {
  tone: "neutral",
  voice: "neutral",
};

/** An unrecognised `[persona]` value, surfaced so the loader can warn (design § 5.1). */
export type PersonaIssue = { key: string; value: string };

const PERSONA_TONES: ReadonlySet<string> = new Set([
  "neutral",
  "terse",
  "formal",
  "casual",
  "verbose",
]);
const PERSONA_VOICES: ReadonlySet<string> = new Set(["neutral", "opinionated", "collective"]);

function applyNimbusPersonaKey(
  out: NimbusPersonaToml,
  key: string,
  valRaw: string,
  issues: PersonaIssue[] | undefined,
): void {
  const v = valRaw.trim().replace(/^"|"$/g, "");
  if (key === "tone") {
    if (PERSONA_TONES.has(v)) out.tone = v as PersonaTone;
    else issues?.push({ key, value: v });
    return;
  }
  if (key === "voice") {
    if (PERSONA_VOICES.has(v)) out.voice = v as PersonaVoice;
    else issues?.push({ key, value: v });
  }
}

export function parseNimbusPersonaToml(
  raw: string,
  defaults: NimbusPersonaToml = DEFAULT_NIMBUS_PERSONA_TOML,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  const out: NimbusPersonaToml = { ...defaults };
  forEachSectionEntry(raw, "[persona]", (key, valRaw) =>
    applyNimbusPersonaKey(out, key, valRaw, issues),
  );
  return out;
}

export function loadNimbusPersonaFromPath(
  tomlPath: string,
  issues?: PersonaIssue[],
): NimbusPersonaToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_PERSONA_TOML, (raw) =>
    parseNimbusPersonaToml(raw, DEFAULT_NIMBUS_PERSONA_TOML, issues),
  );
}

/**
 * The ONE `[agents]` loader. It takes a path, not a config dir, because the path a caller
 * wants is the PROFILE-RESOLVED one (`resolveNimbusTomlForProfile`) — the former
 * `loadNimbusAgentsFromConfigDir` hardcoded `nimbus.toml` and was therefore profile-BLIND,
 * which silently discarded `[agents] synthesis` set in a profile TOML. A2 moved the sole
 * production caller (`agents/_lib/agent-synthesis-runner.ts`) onto this function and DELETED
 * the config-dir variant rather than leaving a profile-blind loader exported beside the
 * profile-aware one for someone to reach for by accident. See the design spec § 5.1.
 */
export function loadNimbusAgentsFromPath(tomlPath: string): NimbusAgentsToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusAgentsToml);
}

// ---------------------------------------------------------------------------

// The DORA / CI service-config machinery (parsing + materialization) lives in
// `./service-config-toml.ts` and is re-exported from this module via the
// `export *` barrel near the top. `loadNimbusServiceConfigsFromConfigDir`
// stays here because it bridges that machinery with the `[pagerduty]` section
// parser (`parseNimbusPagerdutyToml`) defined above — keeping it here avoids a
// `service-config-toml.ts` → `nimbus-toml.ts` circular import.
export function loadNimbusServiceConfigsFromConfigDir(
  configDir: string,
): Map<string, ServiceConfig> {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return new Map();
  const raw = readFileSync(tomlPath, "utf8");
  const dora = parseNimbusDoraToml(raw);
  const ci = parseNimbusCiServiceToml(raw);
  const pagerdutyCfg = parseNimbusPagerdutyToml(raw);
  const aliases = pagerdutyCfg.severityP1Aliases;
  const merged: Map<string, ServiceConfig> = new Map();
  for (const [id, cfg] of dora.entries()) {
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  for (const [id, cfg] of ci.entries()) {
    if (merged.has(id)) {
      process.stderr.write(
        `[ci.service.${id}] and [metrics.dora.${id}] both define service '${id}'; ` +
          `using [ci.service.${id}].\n`,
      );
    }
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  return merged;
}

export {
  type ConnectorCredentialConfig,
  type ConnectorsConfig,
  loadNimbusConnectorsFromConfigDir,
  parseNimbusConnectorsToml,
  TEAM_CREDENTIAL_CONNECTORS,
  type TeamCredentialConnector,
} from "./nimbus-toml-connectors.ts";

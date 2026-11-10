// packages/gateway/src/connectors/connector-writes/flags.ts
import {
  beforeReplyJson,
  excerptHead,
  positiveIntegerArg,
  presentFields,
  stringAt,
} from "./before-select.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeStateField,
  type BeforeStateGuard,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A non-empty string input, else `undefined`. */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Compact JSON of any value for display; `undefined` when it cannot be encoded. */
function jsonText(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined;
  }
}

/** `String(percent)` followed by `%`. */
const pct = (n: number): string => `${String(n)}%`;

/** The `Change` line for a boolean switch: what the write does against the current state. */
function switchChange(now: boolean | undefined, wanted: unknown): string | undefined {
  if (now === undefined || typeof wanted !== "boolean") return undefined;
  if (wanted === now) return `no change (already ${now ? "on" : "off"})`;
  return wanted ? "turns it ON (it is off now)" : "turns it OFF (it is on now)";
}

// ---- LaunchDarkly ------------------------------------------------------------------------------

interface LdVariation {
  readonly id: string;
  /** The name, else the value, else the id: never empty. */
  readonly label: string;
}

interface LdState {
  readonly on: boolean;
  readonly variations: readonly LdVariation[];
  readonly offVariationId: string | undefined;
  readonly offVariationRaw: unknown;
  /** Variation id to percent, when the fallthrough is a rollout. */
  readonly rolloutNow: ReadonlyMap<string, number> | undefined;
  /** The variation id, when the fallthrough is a single variation. */
  readonly singleNow: string | undefined;
  readonly version: string | undefined;
}

/** A variation's display label: its name, else its value, else its id (never `undefined`). */
function variationLabel(v: Record<string, unknown>, id: string): string {
  const name = nonEmpty(v["name"]);
  if (name !== undefined) return name;
  const value = v["value"];
  let text = "";
  if (typeof value === "string") text = value;
  else if (isRecord(value) || Array.isArray(value)) text = jsonText(value) ?? "";
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    text = String(value);
  return text === "" ? id : text;
}

function rolloutNowOf(fallthrough: unknown): ReadonlyMap<string, number> | undefined {
  if (!isRecord(fallthrough) || !Array.isArray(fallthrough["rollout"])) return undefined;
  const out = new Map<string, number>();
  for (const entry of fallthrough["rollout"] as unknown[]) {
    const id = isRecord(entry) ? nonEmpty(entry["variationId"]) : undefined;
    const weight = isRecord(entry) ? entry["weightPercent"] : undefined;
    if (id !== undefined && typeof weight === "number" && Number.isFinite(weight)) {
      out.set(id, weight);
    }
  }
  return out;
}

/**
 * The reply of `launchdarkly_flag_state_get` (the connector's `projectFlagState`): `on` must be a
 * boolean, else this throws and the prompt reads `unavailable (failed)`. A variation without an id
 * cannot be named by a write and is dropped.
 */
function parseLdState(reply: unknown): LdState {
  const j = beforeReplyJson(reply);
  if (!isRecord(j) || typeof j["on"] !== "boolean") throw new Error("before reply: no on");
  const variations: LdVariation[] = [];
  for (const v of Array.isArray(j["variations"]) ? (j["variations"] as unknown[]) : []) {
    const id = isRecord(v) ? nonEmpty(v["id"]) : undefined;
    if (isRecord(v) && id !== undefined) variations.push({ id, label: variationLabel(v, id) });
  }
  const fallthrough = j["fallthrough"];
  return {
    on: j["on"],
    variations,
    offVariationId: nonEmpty(j["offVariationId"]),
    offVariationRaw: j["offVariation"],
    rolloutNow: rolloutNowOf(fallthrough),
    singleNow: isRecord(fallthrough) ? nonEmpty(fallthrough["variationId"]) : undefined,
    version: stringAt(j, ["version"]),
  };
}

/** `<name> (<id>)`, capped; an id the flag does not list shows as the bare id. */
function ldVariationText(state: LdState, id: string): string {
  const found = state.variations.find((v) => v.id === id);
  return found === undefined
    ? excerptHead(id)
    : `${excerptHead(found.label)} (${excerptHead(found.id)})`;
}

function ldOffVariation(state: LdState): string | undefined {
  if (state.offVariationId !== undefined) return ldVariationText(state, state.offVariationId);
  const raw = state.offVariationRaw;
  return typeof raw === "number" ? `unresolved (raw value ${String(raw)})` : undefined;
}

function ldFallthrough(state: LdState): string | undefined {
  if (state.rolloutNow !== undefined) return "rollout";
  return state.singleNow === undefined
    ? undefined
    : `single variation ${ldVariationText(state, state.singleNow)}`;
}

/**
 * LaunchDarkly flag toggle (before-state): `On now`, the `Change` the write makes against it, the
 * off variation and the fallthrough, all for the ONE environment the write names.
 */
export function selectLaunchdarklyToggle(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const s = parseLdState(reply);
  return presentFields([
    ["On now", String(s.on)],
    ["Change", switchChange(s.on, picked["on"])],
    ["Off variation", ldOffVariation(s)],
    ["Fallthrough now", ldFallthrough(s)],
  ]);
}

interface RequestedWeight {
  readonly text: string;
  readonly value?: number;
}

/** The request's rollout as `variation id -> percent`, first mention wins; junk entries skipped. */
function requestedWeights(weights: unknown): Map<string, RequestedWeight> {
  const out = new Map<string, RequestedWeight>();
  if (!Array.isArray(weights)) return out;
  for (const entry of weights as unknown[]) {
    const id = isRecord(entry) ? nonEmpty(entry["variationId"]) : undefined;
    if (id === undefined || !isRecord(entry) || out.has(id)) continue;
    const percent = entry["percent"];
    out.set(
      id,
      typeof percent === "number" && Number.isFinite(percent)
        ? { text: pct(percent), value: percent }
        : { text: "(percent is not a number)" },
    );
  }
  return out;
}

/** The percentage a variation has NOW: a rollout weight, or 100 / 0 against a single variation. */
function ldNowText(state: LdState, id: string): string {
  if (state.rolloutNow !== undefined) return pct(state.rolloutNow.get(id) ?? 0);
  if (state.singleNow !== undefined) return pct(state.singleNow === id ? 100 : 0);
  return "unknown";
}

/**
 * LaunchDarkly rollout (before-state): one line per variation of the flag, by name and id, as
 * `now 50% -> 60%`; a variation the request does not name reads `NOT IN THIS REQUEST`; an id the
 * flag does not have reads `UNKNOWN variation id <id>`. Then the request's total, and the
 * environment's `On now`, `Off variation`, `Fallthrough now` and `Version`. The variation lines come
 * FIRST, and the guard keeps the flag to {@link ROLLOUT_MAX_VARIATIONS} variations so that the
 * variation lines plus the five fixed lines fit {@link BEFORE_STATE_MAX_FIELDS}: nothing is cut.
 */
export function selectLaunchdarklyRollout(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const s = parseLdState(reply);
  const asked = requestedWeights(picked["weights"]);
  const fields: BeforeStateField[] = [];
  for (const v of s.variations) {
    const next = asked.get(v.id)?.text ?? "NOT IN THIS REQUEST";
    fields.push({
      label: `${excerptHead(v.label)} (${excerptHead(v.id)})`,
      value: `now ${ldNowText(s, v.id)} -> ${next}`,
    });
  }
  const known = new Set(s.variations.map((v) => v.id));
  for (const [id, want] of asked) {
    if (known.has(id)) continue;
    fields.push({
      label: `UNKNOWN variation id ${excerptHead(id)}`,
      value: `requested ${want.text}, but the flag has no such variation`,
    });
  }
  const values = [...asked.values()].flatMap((w) => (w.value === undefined ? [] : [w.value]));
  const total =
    values.length === 0
      ? undefined
      : pct(Math.round(values.reduce((a, b) => a + b, 0) * 1000) / 1000);
  return [
    ...fields,
    ...presentFields([
      ["Total in this request", total],
      ["On now", String(s.on)],
      ["Off variation", ldOffVariation(s)],
      ["Fallthrough now", ldFallthrough(s)],
      ["Version", s.version],
    ]),
  ];
}

/**
 * The fixed lines a rollout's before-state ends with: `Total in this request`, `On now`,
 * `Off variation`, `Fallthrough now` and `Version`. The guard refuses a request naming an id the
 * flag lacks, so no `UNKNOWN` line is ever added to the variation lines.
 */
const ROLLOUT_FIXED_FIELDS = 5;

/** The most variations a rollout can list with every field shown (variation lines + fixed lines). */
export const ROLLOUT_MAX_VARIATIONS = BEFORE_STATE_MAX_FIELDS - ROLLOUT_FIXED_FIELDS;

/**
 * The rollout guard (fail closed): the write is allowed only when the flag was read, the request
 * names EVERY variation of the flag exactly once and no id the flag lacks, and the flag is small
 * enough that the prompt lists each variation plus every fixed line without the runner cutting a field
 * (the connector sends only the ids it is given, and LaunchDarkly's behaviour for an omitted one is
 * not stated; the owner must see every percentage). A reader outage refuses a rollout.
 */
const ROLLOUT_NAMES_EVERY_VARIATION: BeforeStateGuard = {
  reason: "name every variation of the flag, by id from launchdarkly_flag_state_get",
  appliesTo: () => true,
  allows: (reply, picked) => {
    try {
      const flagIds = new Set(parseLdState(reply).variations.map((v) => v.id));
      // Every field must fit the runner's cap: one line per variation plus the fixed lines.
      if (flagIds.size === 0 || flagIds.size > ROLLOUT_MAX_VARIATIONS) return false;
      const weights = picked["weights"];
      if (!Array.isArray(weights) || weights.length === 0) return false;
      const named = new Set<string>();
      for (const entry of weights as unknown[]) {
        const id = isRecord(entry) ? nonEmpty(entry["variationId"]) : undefined;
        if (id === undefined || named.has(id) || !flagIds.has(id)) return false;
        named.add(id);
      }
      return named.size === flagIds.size;
    } catch {
      return false;
    }
  },
};

/** `launchdarkly_flag_state_get` input from a flag write: three non-empty strings; else no read. */
function launchdarklyReadArgs(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const projectKey = nonEmpty(input["projectKey"]);
  const flagKey = nonEmpty(input["flagKey"]);
  const environmentKey = nonEmpty(input["environmentKey"]);
  return projectKey === undefined || flagKey === undefined || environmentKey === undefined
    ? undefined
    : { projectKey, flagKey, environmentKey };
}

// ---- Flagsmith ---------------------------------------------------------------------------------

/** The typed value of a feature state: `<type> <value>`, else the raw JSON excerpt, else `unknown`. */
function flagsmithValueText(value: unknown): string {
  if (isRecord(value) && typeof value["type"] === "string") {
    const inner = value["value"];
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") {
      return excerptHead(`${value["type"]} ${String(inner)}`);
    }
  }
  const raw = value === undefined ? undefined : jsonText(value);
  return raw === undefined ? "unknown" : excerptHead(raw);
}

/** The requested typed value as `{ type, text }`, or `undefined` when the request sets none. */
function requestedFlagsmithValue(
  v: unknown,
): { readonly type: string | undefined; readonly text: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (isRecord(v)) {
    const type = typeof v["type"] === "string" ? v["type"] : undefined;
    const inner = v["value"];
    const shown =
      typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean"
        ? String(inner)
        : (jsonText(inner) ?? "unknown");
    return { type, text: excerptHead(`${type ?? "?"} ${shown}`) };
  }
  return { type: undefined, text: excerptHead(jsonText(v) ?? "unknown") };
}

/** The `Change` line's value part: sets the value to `<type> <value>`, naming a type change. */
function flagsmithValueChange(now: unknown, wanted: unknown): string | undefined {
  const req = requestedFlagsmithValue(wanted);
  if (req === undefined) return undefined;
  const nowType = isRecord(now) && typeof now["type"] === "string" ? now["type"] : undefined;
  let typeNote = "";
  if (req.type !== undefined && nowType === undefined) {
    typeNote = " (the current type is unknown)";
  } else if (req.type !== undefined && nowType !== req.type) {
    typeNote = ` (the type changes from ${excerptHead(nowType ?? "unknown")} to ${excerptHead(req.type)})`;
  }
  return `sets the value to ${req.text}${typeNote}`;
}

/** The whole `Change` line: the enabled switch and, when the request carries one, the value. */
function flagsmithChange(
  enabled: boolean | undefined,
  picked: Readonly<Record<string, unknown>>,
  nowValue: unknown,
): string | undefined {
  const parts = [
    switchChange(enabled, picked["enabled"]),
    flagsmithValueChange(nowValue, picked["value"]),
  ].filter((x): x is string => x !== undefined);
  return parts.length === 0 ? undefined : parts.join("; ");
}

/**
 * Flagsmith feature state (before-state): `Enabled now`, the `Change` the write makes, `Value now`
 * (the value shape was verified only from the docs, so an unexpected one shows as raw JSON or
 * `unknown`, never a failure) and the segment overrides, which this write does not change. Only a
 * reply without `environment_default` throws.
 */
export function selectFlagsmithState(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const def = isRecord(j) ? j["environment_default"] : undefined;
  if (!isRecord(def)) throw new Error("before reply: no environment_default");
  const enabled = typeof def["enabled"] === "boolean" ? def["enabled"] : undefined;
  const overrides = isRecord(j) ? j["segment_overrides"] : undefined;
  const more = isRecord(j) ? j["segmentOverridesNotShown"] : undefined;
  let segments = "unknown";
  if (Array.isArray(overrides)) {
    segments = `${String(overrides.length)} (not changed by this write)`;
    if (typeof more === "number" && Number.isFinite(more) && more > 0) {
      segments += ` (${String(more)} more not shown)`;
    }
  }
  return presentFields([
    ["Enabled now", enabled === undefined ? "unknown" : String(enabled)],
    ["Change", flagsmithChange(enabled, picked, def["value"])],
    ["Value now", flagsmithValueText(def["value"])],
    ["Segment overrides", segments],
  ]);
}

// Feature-flag writes (connectors 0.6.0, spec 15.3, OR-W34-6). All three are wave 3: a flag change
// can be reverted by flipping it back, so none is wave 4. The environment comes FIRST in each
// preview (target, summary and field order): the same change in production and in staging must not
// look alike. They are offered to the model, not proposable over MCP (`not_yet_offered`: the act
// door has no before-read, and a variation id is opaque without one).
export const FLAGS_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("launchdarkly_flag_toggle", "launchdarkly.flag.toggle", "mesh", 3), {
      target: "{environmentKey}: {projectKey}/{flagKey}",
      summary:
        "In environment {environmentKey}: turn LaunchDarkly flag {flagKey} on or off (requested: on = {on}; project {projectKey})",
      fields: [
        textField("environmentKey", "Environment"),
        textField("projectKey"),
        textField("flagKey"),
        textField("on", "Turn it on (true) or off (false)"),
      ],
    }),
    {
      tool: "launchdarkly_flag_state_get",
      // `on` is declared for the select, never sent to the read.
      argKeys: ["environmentKey", "projectKey", "flagKey", "on"],
      args: launchdarklyReadArgs,
      select: selectLaunchdarklyToggle,
    },
  ),
  withBefore(
    withPreview(row("launchdarkly_flag_rollout_set", "launchdarkly.flag.rollout.set", "mesh", 3), {
      target: "{environmentKey}: {projectKey}/{flagKey}",
      summary:
        "In environment {environmentKey}: set the percentage rollout of LaunchDarkly flag {flagKey} (project {projectKey}); every variation's percentage is listed below",
      fields: [
        textField("environmentKey", "Environment"),
        textField("projectKey"),
        textField("flagKey"),
        textField("weights", "Rollout (percent per variation id, must total 100)"),
      ],
    }),
    {
      tool: "launchdarkly_flag_state_get",
      // `weights` is declared for the select and the guard, never sent to the read.
      argKeys: ["environmentKey", "projectKey", "flagKey", "weights"],
      args: launchdarklyReadArgs,
      select: selectLaunchdarklyRollout,
      guard: ROLLOUT_NAMES_EVERY_VARIATION,
    },
  ),
  withBefore(
    withPreview(row("flagsmith_feature_state_set", "flagsmith.feature.state.set", "mesh", 3), {
      target: "{environmentKey}: feature {featureId}",
      summary:
        "In environment {environmentKey}: enable or disable Flagsmith feature {featureId} (requested: enabled = {enabled}) and set its value when one is given",
      fields: [
        textField("environmentKey", "Environment"),
        // Flagsmith's read carries no feature NAME, so the preview can show only the id.
        textField("featureId", "Feature id (the preview cannot show its name)"),
        textField("enabled"),
        textField("value", "value", "(not set: the value is left as it is)"),
      ],
    }),
    {
      tool: "flagsmith_feature_state_get",
      // `enabled` and `value` are declared for the select, never sent to the read.
      argKeys: ["environmentKey", "featureId", "enabled", "value"],
      args: (input) => {
        const environmentKey = nonEmpty(input["environmentKey"]);
        const featureId = positiveIntegerArg(input["featureId"]);
        return environmentKey === undefined || featureId === undefined
          ? undefined
          : { environmentKey, featureId };
      },
      select: selectFlagsmithState,
    },
  ),
];

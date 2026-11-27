// packages/gateway/src/connectors/connector-writes/unleash-split-rows.ts
// The Unleash toggle and the Split kill and restore (`@nimbus-dev/connectors` 0.22.0): Wave 3 flag
// writes offered to the model behind a typed preview and a before-state read, kept out of
// `flags.ts` so that file stays under the `audit:file-size` limit. Spread into the one row table by
// `index.ts`. As in `flags.ts`, the environment comes FIRST in each preview (target, summary and
// field order): the same change in production and in staging must not look alike.
import { beforeReplyJson, excerptHead, nonEmptyString, presentFields } from "./before-select.ts";
import { switchChange } from "./flags.ts";
import {
  type BeforeStateField,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A count from a `*NotShown` key: a positive finite number, else 0. */
function notShown(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/** `<n>`, plus `(<m> more not shown)` when the connector capped the list. */
function countText(n: number, more: number): string {
  return more > 0 ? `${String(n)} (${String(more)} more not shown)` : String(n);
}

// ---- Unleash -----------------------------------------------------------------------------------

/**
 * Whether the environment has an ACTIVE strategy (one Unleash does not mark `disabled: true`), from
 * the reply of `unleash_feature_state_get`: `yes`, `no`, or `unknown` when the strategies are not a
 * list, or when none of the shown ones is active but the connector capped the list. Unleash adds a
 * default strategy when it enables an environment with no active strategy (none, or only disabled
 * ones), and turning the environment off later does not remove it.
 */
export function unleashActiveStrategy(reply: unknown): "yes" | "no" | "unknown" {
  const j = beforeReplyJson(reply);
  const strategies = isRecord(j) ? j["strategies"] : undefined;
  if (!Array.isArray(strategies)) return "unknown";
  if (strategies.some((s) => isRecord(s) && s["disabled"] !== true)) return "yes";
  return notShown(isRecord(j) ? j["strategiesNotShown"] : undefined) > 0 ? "unknown" : "no";
}

/** The `Enabled now` of an Unleash environment; a reply without a boolean `enabled` throws. */
export function unleashEnabledNow(reply: unknown): boolean {
  const j = beforeReplyJson(reply);
  if (!isRecord(j) || typeof j["enabled"] !== "boolean")
    throw new Error("before reply: no enabled");
  return j["enabled"];
}

const UNLEASH_DEFAULT_STRATEGY =
  "turning this on makes Unleash add a default strategy (a gradual rollout to 100% unless the project sets another default), which turning it off later does not remove";

/** The `Default strategy` line: shown only for a request that turns the environment on. */
function unleashDefaultStrategyLine(
  active: "yes" | "no" | "unknown",
  wanted: unknown,
): string | undefined {
  if (wanted !== true) return undefined;
  if (active === "yes") return "none added (the environment already has an active strategy)";
  return active === "no"
    ? UNLEASH_DEFAULT_STRATEGY
    : `unknown whether one is added: not every strategy is shown; ${UNLEASH_DEFAULT_STRATEGY}`;
}

/**
 * Unleash toggle (before-state): `Enabled now`, the `Change` the write makes against it, the
 * environment's strategies (active and disabled), whether Unleash will add a default strategy, and
 * the variant count, all for the ONE environment the write names.
 */
export function selectUnleashToggle(
  reply: unknown,
  picked: Readonly<Record<string, unknown>>,
): readonly BeforeStateField[] {
  const enabled = unleashEnabledNow(reply);
  const j = beforeReplyJson(reply) as Record<string, unknown>;
  const active = unleashActiveStrategy(reply);
  const strategies = Array.isArray(j["strategies"]) ? (j["strategies"] as unknown[]) : undefined;
  const variants = Array.isArray(j["variants"]) ? (j["variants"] as unknown[]) : undefined;
  let strategyText: string | undefined;
  if (strategies !== undefined) {
    const disabled = strategies.filter((s) => isRecord(s) && s["disabled"] === true).length;
    const total = countText(strategies.length, notShown(j["strategiesNotShown"]));
    strategyText = `${total} (${String(strategies.length - disabled)} active, ${String(disabled)} disabled)`;
  }
  return presentFields([
    ["Enabled now", String(enabled)],
    ["Change", switchChange(enabled, picked["enabled"])],
    ["Strategies", strategyText],
    ["Default strategy", unleashDefaultStrategyLine(active, picked["enabled"])],
    [
      "Variants",
      variants === undefined
        ? undefined
        : countText(variants.length, notShown(j["variantsNotShown"])),
    ],
  ]);
}

/** `unleash_feature_state_get` input from the toggle: three non-empty strings; else no read. */
export function unleashReadArgs(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const projectId = nonEmptyString(input["projectId"]);
  const featureName = nonEmptyString(input["featureName"]);
  const environment = nonEmptyString(input["environment"]);
  return projectId === undefined || featureName === undefined || environment === undefined
    ? undefined
    : { projectId, featureName, environment };
}

// ---- Split -------------------------------------------------------------------------------------

/** The `killed` of a Split definition; a reply without a boolean `killed` throws. */
export function splitKilledNow(reply: unknown): boolean {
  const j = beforeReplyJson(reply);
  if (!isRecord(j) || typeof j["killed"] !== "boolean") throw new Error("before reply: no killed");
  return j["killed"];
}

/** The lines both Split rows show after `Killed now` and `Change`. */
function splitStateFields(j: Record<string, unknown>): [string, string | undefined][] {
  const defaultTreatment = j["defaultTreatment"];
  const treatments = Array.isArray(j["treatments"]) ? (j["treatments"] as unknown[]) : undefined;
  const rules = Array.isArray(j["rules"]) ? (j["rules"] as unknown[]) : undefined;
  return [
    [
      "Default treatment",
      typeof defaultTreatment === "string" && defaultTreatment !== ""
        ? excerptHead(defaultTreatment)
        : undefined,
    ],
    [
      "Treatments",
      treatments === undefined
        ? undefined
        : countText(treatments.length, notShown(j["treatmentsNotShown"])),
    ],
    [
      "Targeting rules",
      rules === undefined
        ? undefined
        : `${countText(rules.length, notShown(j["rulesNotShown"]))} (not changed by this write)`,
    ],
  ];
}

/**
 * Split kill (before-state): `Killed now`, the `Change` (a kill makes every evaluation serve the
 * default treatment, which is named), the treatments and the targeting rules.
 */
export function selectSplitKill(reply: unknown): readonly BeforeStateField[] {
  const killed = splitKilledNow(reply);
  const j = beforeReplyJson(reply) as Record<string, unknown>;
  return presentFields([
    ["Killed now", String(killed)],
    [
      "Change",
      killed
        ? "no change (already killed)"
        : "kills it: every evaluation then serves the default treatment",
    ],
    ...splitStateFields(j),
  ]);
}

/** Split restore (before-state): `Killed now`, the `Change` (the rules apply again), as for a kill. */
export function selectSplitRestore(reply: unknown): readonly BeforeStateField[] {
  const killed = splitKilledNow(reply);
  const j = beforeReplyJson(reply) as Record<string, unknown>;
  return presentFields([
    ["Killed now", String(killed)],
    [
      "Change",
      killed ? "restores it: its targeting rules apply again" : "no change (it is not killed)",
    ],
    ...splitStateFields(j),
  ]);
}

/** `split_definition_get` input from a kill or restore: three non-empty strings; else no read. */
export function splitReadArgs(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const workspaceId = nonEmptyString(input["workspaceId"]);
  const splitName = nonEmptyString(input["splitName"]);
  const environment = nonEmptyString(input["environment"]);
  return workspaceId === undefined || splitName === undefined || environment === undefined
    ? undefined
    : { workspaceId, splitName, environment };
}

const SPLIT_FIELDS = [
  textField("environment", "Environment"),
  textField("workspaceId", "Workspace id"),
  textField("splitName", "Split"),
];

// Owner rulings 2026-11-27 (connectors 0.22.0): all three are Wave 3 and offered to the model. Their
// reversibility is in `reversibility.ts`: the Split kill and restore are each the other's inverse;
// the Unleash toggle is undone by the opposite toggle only when that restores what it changed.
export const UNLEASH_SPLIT_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("unleash_feature_toggle", "unleash.feature.toggle", "mesh", 3), {
      target: "{environment}: {projectId}/{featureName}",
      summary:
        "In environment {environment}: turn Unleash feature {featureName} on or off (requested: enabled = {enabled}; project {projectId})",
      fields: [
        textField("environment", "Environment"),
        textField("projectId", "Project"),
        textField("featureName", "Feature"),
        textField("enabled", "Turn it on (true) or off (false)"),
      ],
    }),
    {
      tool: "unleash_feature_state_get",
      // `enabled` is declared for the select, never sent to the read.
      argKeys: ["environment", "projectId", "featureName", "enabled"],
      args: unleashReadArgs,
      select: selectUnleashToggle,
    },
  ),
  withBefore(
    withPreview(row("split_kill", "split.flag.kill", "mesh", 3), {
      target: "{environment}: {workspaceId}/{splitName}",
      summary:
        "In environment {environment}: kill Split split {splitName} (workspace {workspaceId}); every evaluation then serves its default treatment, whatever its rules say",
      fields: SPLIT_FIELDS,
    }),
    {
      tool: "split_definition_get",
      argKeys: ["environment", "workspaceId", "splitName"],
      args: splitReadArgs,
      select: selectSplitKill,
    },
  ),
  withBefore(
    withPreview(row("split_restore", "split.flag.restore", "mesh", 3), {
      target: "{environment}: {workspaceId}/{splitName}",
      summary:
        "In environment {environment}: restore killed Split split {splitName} (workspace {workspaceId}); its targeting rules apply again",
      fields: SPLIT_FIELDS,
    }),
    {
      tool: "split_definition_get",
      argKeys: ["environment", "workspaceId", "splitName"],
      args: splitReadArgs,
      select: selectSplitRestore,
    },
  ),
];

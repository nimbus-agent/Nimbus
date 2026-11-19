// packages/gateway/src/connectors/connector-writes/dry-run-predict.ts
// Phase 17 "Confidence + evidence + dry-run remediation" (stream R2). The remediation dry run's PREDICTION: given a
// proposal's tool, its stored input and the machine values its row's before reader captured
// (`reversibility.ts`, beside it), what the write would change. It lives here because it names write tool ids (static
// D20). Pure: no import, no I/O. It is a prediction from a live read, never a simulation by the provider.

export type DryRunVerdict = "would_change" | "no_change" | "uncertain" | "none";

export type DryRunPrediction = {
  readonly verdict: DryRunVerdict;
  readonly text: string;
};

/** The label every dry run carries, wherever it is shown. */
export const DRY_RUN_LABEL =
  "Predicted from a live read; the provider was not asked to simulate the change.";

/** The tools whose before reader captures the value a prediction needs. */
export const PREDICTABLE_TOOLS: readonly string[] = Object.freeze([
  "launchdarkly_flag_toggle",
  "flagsmith_feature_state_set",
  "aws_ec2_instance_stop",
  "aws_ec2_instance_start",
  "aws_ecs_service_update",
  "argocd_app_rollback",
]);

/** What `--dry-run` can do for a proposal's tool: predict, show the current state only, or nothing. */
export type DryRunKind = "predicted" | "current_state" | "none";

export function dryRunKindOf(toolId: string, hasReader: boolean): DryRunKind {
  if (!hasReader) return "none";
  return PREDICTABLE_TOOLS.includes(toolId) ? "predicted" : "current_state";
}

const none = (text: string): DryRunPrediction => ({ verdict: "none", text });
const uncertain = (text: string): DryRunPrediction => ({ verdict: "uncertain", text });

function scalarText(v: unknown): string | undefined {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v)
    : undefined;
}

function boolPrediction(
  field: string,
  before: string | undefined,
  wanted: unknown,
): DryRunPrediction {
  if (before !== "true" && before !== "false") return none(`the current ${field} was not read`);
  if (typeof wanted !== "boolean") return uncertain(`the proposal sets no ${field} value`);
  const after = String(wanted);
  return before === after
    ? { verdict: "no_change", text: `${field} is already ${after}: no change` }
    : { verdict: "would_change", text: `${field}: ${before} -> ${after}` };
}

/** EC2: the target state of each call, the states that already satisfy it, and the state it starts from. */
const EC2 = {
  aws_ec2_instance_stop: { from: "running", to: "stopping", done: ["stopped", "stopping"] },
  aws_ec2_instance_start: { from: "stopped", to: "pending", done: ["running", "pending"] },
} as const;

function ec2Prediction(toolId: keyof typeof EC2, state: string | undefined): DryRunPrediction {
  const spec = EC2[toolId];
  if (state === undefined) return none("the instance state was not read");
  if (state === spec.from) {
    return { verdict: "would_change", text: `instance state: ${state} -> ${spec.to}` };
  }
  if ((spec.done as readonly string[]).includes(state)) {
    return { verdict: "no_change", text: `the instance is already ${state}: no change` };
  }
  return uncertain(`the instance is ${state}; the outcome depends on the provider`);
}

/**
 * The predicted outcome of `toolId` with `input`, from the before reader's `captured` values. `captured` undefined
 * means the read captured nothing (a failed read, or a row without captures). Deterministic: the same arguments
 * always give the same result.
 */
export function predictOutcome(
  toolId: string,
  input: unknown,
  captured: Readonly<Record<string, string>> | undefined,
): DryRunPrediction {
  if (!PREDICTABLE_TOOLS.includes(toolId)) {
    return none("no outcome is predicted for this action; its current state is shown above");
  }
  if (captured === undefined) return none("the current state could not be read");
  const inp =
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Readonly<Record<string, unknown>>)
      : {};
  switch (toolId) {
    case "launchdarkly_flag_toggle":
      return boolPrediction("on", captured["on"], inp["on"]);
    case "flagsmith_feature_state_set": {
      const p = boolPrediction("enabled", captured["enabled"], inp["enabled"]);
      return inp["value"] === undefined
        ? p
        : { verdict: p.verdict === "none" ? "none" : "uncertain", text: `${p.text}; the feature value is also set and is not compared` };
    }
    case "aws_ec2_instance_stop":
    case "aws_ec2_instance_start":
      return ec2Prediction(toolId, captured["state"]);
    case "aws_ecs_service_update": {
      const before = captured["taskDefinition"];
      const after = scalarText(inp["taskDefinition"]);
      if (before === undefined) return none("the current task definition was not read");
      if (after === undefined) return uncertain("the proposal names no task definition");
      return before === after
        ? { verdict: "no_change", text: `the service already runs ${after}: no change` }
        : { verdict: "would_change", text: `task definition: ${before} -> ${after}` };
    }
    default: {
      // argocd_app_rollback
      const current = captured["currentHistoryId"];
      const target = scalarText(inp["id"]);
      if (current === undefined) return none("the current deployment history was not read");
      if (target === undefined) return uncertain("the proposal names no history id");
      if (captured["autoSync"] === "on") {
        return uncertain("auto-sync is on: Argo CD refuses a rollback while it is on");
      }
      const kept = captured["historyIds"]?.split(",");
      if (kept === undefined || captured["autoSync"] !== "off") {
        return uncertain("the application's sync policy or retained history was not read");
      }
      if (!kept.includes(target)) {
        return uncertain(`history ${target} is no longer in the application's retained history`);
      }
      return current === target
        ? { verdict: "no_change", text: `the application is already at history ${target}: no change` }
        : {
            verdict: "would_change",
            text: `the application moves from history ${current} back to the revision of history ${target}`,
          };
    }
  }
}

/**
 * The refresh-only side of the Terraform settler (owner ruling OR-S4-DRIFT, 2026-11-23; invariant
 * I54): accepting drift into the Terraform state. `terraform apply` of a refresh-only plan updates
 * the state to match what exists and must change no infrastructure, so the gateway checks that
 * itself from the rendering of `terraform show -json` (never from what the plan child or the
 * connector says) and shows the owner the drift in full or refuses.
 *
 * Pure: it reads a {@link PlanPreview} the settler already rendered and returns a fixed reason or
 * the fields the owner sees. It touches no file and no process.
 */

import type { PlanPreview } from "../connectors/connector-writes/iac-plan-preview.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";

/** The file name a plan is saved under: the KIND of plan is its name (apply, destroy, refresh-only). */
export const PLAN_NAME = "plan.tfplan";
export const DESTROY_PLAN_NAME = "destroy.tfplan";
export const REFRESH_PLAN_NAME = "refresh.tfplan";

export function planFileName(kind: {
  destroy: boolean;
  refreshOnly?: boolean | undefined;
}): string {
  if (kind.refreshOnly === true) return REFRESH_PLAN_NAME;
  return kind.destroy ? DESTROY_PLAN_NAME : PLAN_NAME;
}

/**
 * Terraform 1.14 saves provider actions in `action_invocations`, apart from the resource changes,
 * and applying the file runs them. The renderer does not read the key, so it is checked here:
 * anything but an absent key or an empty list counts.
 */
function savesProviderActions(plan: unknown): boolean {
  if (typeof plan !== "object" || plan === null) return false;
  const invocations = (plan as Record<string, unknown>)["action_invocations"];
  return invocations !== undefined && (!Array.isArray(invocations) || invocations.length > 0);
}

/**
 * Why a rendered plan may not be accepted as a refresh-only plan, or `undefined`. A refresh-only
 * plan holds no planned create, update, delete or replace (a data-source read is not a change);
 * and the drift it accepts must be a number above zero that the preview listed object by object,
 * since approving state the owner was not shown is not an approval.
 */
export function refreshOnlyRefusal(preview: PlanPreview, plan: unknown): string | undefined {
  if (preview.changeCount !== 0 || savesProviderActions(plan)) {
    return PREPARE_REFUSALS.notRefreshOnly;
  }
  const drift = preview.driftCount;
  // `null`: the field was not the documented shape.
  if (drift === null) return PREPARE_REFUSALS.unshowable;
  if (drift === 0) return PREPARE_REFUSALS.nothingToApply;
  // One line only: more objects than the block lists (or its byte budget holds).
  return preview.driftLines.length <= 1 ? PREPARE_REFUSALS.diffTooLarge : undefined;
}

/** The labelled facts shown beside a refresh-only plan: its hash, the directory and what it does. */
export function refreshOnlyFields(
  preview: PlanPreview,
  workingDirectory: string,
  planSha256: string,
): { readonly label: string; readonly value: string }[] {
  return [
    { label: "Plan SHA-256", value: planSha256 },
    { label: "Workdir", value: workingDirectory },
    {
      label: "Accepts",
      value: `${String(preview.driftCount ?? 0)} objects changed outside Terraform into the state; no infrastructure changes`,
    },
  ];
}

/** The fields of a settled plan: the apply and destroy rows' counts, or the refresh-only row's drift. */
export function settledFields(
  preview: PlanPreview,
  workingDirectory: string,
  planSha256: string,
  refreshOnly: boolean | undefined,
): { readonly label: string; readonly value: string }[] {
  if (refreshOnly) return refreshOnlyFields(preview, workingDirectory, planSha256);
  const { counts } = preview;
  return [
    { label: "Plan SHA-256", value: planSha256 },
    { label: "Workdir", value: workingDirectory },
    {
      label: "Changes",
      value: `${String(counts.create + counts.replace)} to add, ${String(counts.update)} to change, ${String(counts.delete + counts.replace)} to destroy`,
    },
  ];
}

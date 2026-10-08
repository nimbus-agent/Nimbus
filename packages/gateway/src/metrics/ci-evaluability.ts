/**
 * Which CI providers bound to a service the index cannot judge, per use. DERIVED from A1's
 * contract tables, so a writer that starts emitting `branch` (or a success signal) flips its
 * provider to evaluable with no edit here:
 *   - no writer at all (`bitbucket` has no `ci_run` writer) -> unevaluable for every use;
 *   - preflight's failing-runs check filters on `branch` and needs pass/fail -> a provider that
 *     emits no `branch` (Jenkins) or has no success signal (CircleCI) is unevaluable;
 *   - DORA deploy detection needs a success signal (Jenkins matches on `jobName`, so no branch
 *     is fine).
 * Callers turn a non-empty result into the `ci_not_evaluable` gap; it never changes a verdict.
 */
import {
  CI_RUN_EMITTED_KEYS,
  CI_RUN_NO_SUCCESS_SIGNAL,
  type CiRunService,
} from "../connectors/ci-run-meta.ts";
import { distinctCiServiceColumns, type ParsedDoraRepoUrn } from "./dora-config.ts";

export type CiEvaluationUse = "preflight_failing_runs" | "dora_deploys";

function isCiRunService(s: string): s is CiRunService {
  return Object.hasOwn(CI_RUN_EMITTED_KEYS, s);
}

function evaluable(service: string, use: CiEvaluationUse): boolean {
  if (!isCiRunService(service) || CI_RUN_NO_SUCCESS_SIGNAL.has(service)) {
    return false;
  }
  return use === "dora_deploys" || CI_RUN_EMITTED_KEYS[service].has("branch");
}

export function unevaluableCiServices(
  repos: readonly ParsedDoraRepoUrn[],
  use: CiEvaluationUse,
): string[] {
  return distinctCiServiceColumns(repos).filter((s) => !evaluable(s, use));
}

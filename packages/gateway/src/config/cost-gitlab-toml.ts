/**
 * `[cost.gitlab]` - the GitLab compute-minute cost source (Phase 7, the Cost Pack, slice 8; owner rulings
 * 2026-11-28). Read by `cost-toml.ts`, which refuses the whole cost config on any error here, as it does for
 * every cost section.
 *
 * ```toml
 * [cost.gitlab]
 * groups = ["acme", "other-group/platform"]   # full group paths; nothing is synced until this is set
 * rate_per_minute = 0.008                     # the owner's price of one minute; unset = lines are unpriced
 * currency = "USD"                            # ISO 4217, default USD
 * runner_rates = { "big-linux-runner" = 0.02 } # self-managed only: per runner description
 * ```
 *
 * GitLab returns minutes, never money: the rate is the owner's, not GitLab's price. Each group is its own billing
 * account, so one group may not sit inside another listed group (its projects would be counted twice, and the two
 * accounts would replace each other's lines). `runner_rates` is checked for a GitLab.com base by the sync, which is
 * where the base is known: GitLab.com minutes already include the runner cost factor.
 */
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export interface NimbusCostGitlabConfig {
  readonly groups: readonly string[];
  /** Null: no rate, so every line is stored unpriced with its minutes. */
  readonly ratePerMinute: number | null;
  readonly currency: string;
  /** Runner description → rate per minute, sorted by description; empty when unset. */
  readonly runnerRates: readonly (readonly [string, number])[];
}

export const DEFAULT_COST_GITLAB_CONFIG: NimbusCostGitlabConfig = Object.freeze({
  groups: Object.freeze([]) as readonly string[],
  ratePerMinute: null,
  currency: "USD",
  runnerRates: Object.freeze([]) as readonly (readonly [string, number])[],
});

export const COST_GITLAB_MAX_GROUPS = 50;
export const COST_GITLAB_MAX_RUNNER_RATES = 100;
/** A sanity bound on a per-minute price, so a typo of a monthly figure is refused, not billed. */
export const COST_GITLAB_MAX_RATE = 1000;

export class CostGitlabConfigError extends Error {}

/** One group path segment: GitLab's path characters (letters, digits, `_`, `-`, `.`), not starting with `-`/`.`. */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/;

function groupPath(v: unknown): string {
  const shown = JSON.stringify(v).slice(0, 64);
  if (typeof v !== "string" || v.length === 0 || v.length > 255) {
    throw new CostGitlabConfigError(`[cost.gitlab].groups: ${shown} is not a GitLab group path`);
  }
  const segments = v.split("/");
  if (segments.length > 20 || !segments.every((s) => SEGMENT_RE.test(s))) {
    throw new CostGitlabConfigError(`[cost.gitlab].groups: ${shown} is not a GitLab group path`);
  }
  return v;
}

function readGroups(v: unknown): readonly string[] {
  if (v === undefined) return Object.freeze([]);
  if (!Array.isArray(v))
    throw new CostGitlabConfigError("[cost.gitlab].groups must be a list of group paths");
  if (v.length > COST_GITLAB_MAX_GROUPS) {
    throw new CostGitlabConfigError(
      `[cost.gitlab].groups: at most ${String(COST_GITLAB_MAX_GROUPS)}`,
    );
  }
  const groups = (v as unknown[]).map(groupPath);
  const lower = groups.map((g) => g.toLowerCase());
  for (let i = 0; i < lower.length; i++) {
    for (let j = 0; j < lower.length; j++) {
      const a = lower[i] as string;
      const b = lower[j] as string;
      if (i !== j && a === b) {
        throw new CostGitlabConfigError(`[cost.gitlab].groups: ${groups[i] ?? ""} is listed twice`);
      }
      if (b.startsWith(`${a}/`)) {
        throw new CostGitlabConfigError(
          `[cost.gitlab].groups: ${groups[j] ?? ""} is inside ${groups[i] ?? ""}: list one of them`,
        );
      }
    }
  }
  return Object.freeze(groups);
}

function rate(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > COST_GITLAB_MAX_RATE) {
    throw new CostGitlabConfigError(
      `${what} must be a number from 0 to ${String(COST_GITLAB_MAX_RATE)} (a price per minute)`,
    );
  }
  return v;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a runner description must hold no control character
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function readRunnerRates(v: unknown): readonly (readonly [string, number])[] {
  if (v === undefined) return Object.freeze([]);
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CostGitlabConfigError(
      '[cost.gitlab].runner_rates must be a table such as { "big-linux-runner" = 0.02 }',
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > COST_GITLAB_MAX_RUNNER_RATES) {
    throw new CostGitlabConfigError(
      `[cost.gitlab].runner_rates: at most ${String(COST_GITLAB_MAX_RUNNER_RATES)} runners`,
    );
  }
  const out = entries.map(([desc, r]): readonly [string, number] => {
    if (desc.length === 0 || desc.length > 255 || CONTROL_RE.test(desc)) {
      throw new CostGitlabConfigError(
        `[cost.gitlab].runner_rates: ${JSON.stringify(desc).slice(0, 64)} is not a runner description`,
      );
    }
    return Object.freeze([
      desc,
      rate(r, `[cost.gitlab].runner_rates.${JSON.stringify(desc).slice(0, 64)}`),
    ]);
  });
  out.sort((a, b) => codeUnitCompare(a[0], b[0]));
  return Object.freeze(out);
}

/** `[cost.gitlab]` from its parsed table. Throws {@link CostGitlabConfigError}. */
export function readCostGitlabTable(t: Record<string, unknown>): NimbusCostGitlabConfig {
  for (const k of Object.keys(t)) {
    if (!["groups", "rate_per_minute", "currency", "runner_rates"].includes(k)) {
      throw new CostGitlabConfigError(`[cost.gitlab]: unknown key "${k}"`);
    }
  }
  const currency = t["currency"] ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new CostGitlabConfigError(
      "[cost.gitlab].currency must be a three-letter ISO 4217 code such as USD",
    );
  }
  return Object.freeze({
    groups: readGroups(t["groups"]),
    ratePerMinute:
      t["rate_per_minute"] === undefined
        ? null
        : rate(t["rate_per_minute"], "[cost.gitlab].rate_per_minute"),
    currency,
    runnerRates: readRunnerRates(t["runner_rates"]),
  });
}

/**
 * `[cost.bitbucket]` - the Bitbucket Pipelines minutes cost source (Phase 7, the Cost Pack, slice 9; owner rulings
 * 2026-11-28). Read by `cost-toml.ts`, which refuses the whole cost config on any error here, as it does for every
 * cost section.
 *
 * ```toml
 * [cost.bitbucket]
 * workspaces = ["acme", "acme-labs"]  # workspace slugs; nothing is synced until this is set
 * rate_per_minute = 0.01              # the owner's price of one minute; unset = lines are unpriced
 * currency = "USD"                    # ISO 4217, default USD
 * size_rates = { "2x" = 0.02 }        # per step size; used only when the pipeline listing itself carries a size
 * ```
 *
 * Bitbucket returns minutes, never money: the rate is the owner's, not Atlassian's price. Each workspace is its own
 * billing account.
 */
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export interface NimbusCostBitbucketConfig {
  readonly workspaces: readonly string[];
  /** Null: no rate, so every line is stored unpriced with its minutes. */
  readonly ratePerMinute: number | null;
  readonly currency: string;
  /** Step size (`2x`) → rate per minute, sorted by size; empty when unset. */
  readonly sizeRates: readonly (readonly [string, number])[];
}

export const DEFAULT_COST_BITBUCKET_CONFIG: NimbusCostBitbucketConfig = Object.freeze({
  workspaces: Object.freeze([]) as readonly string[],
  ratePerMinute: null,
  currency: "USD",
  sizeRates: Object.freeze([]) as readonly (readonly [string, number])[],
});

export const COST_BITBUCKET_MAX_WORKSPACES = 50;
/** A sanity bound on a per-minute price, so a typo of a monthly figure is refused, not billed. */
export const COST_BITBUCKET_MAX_RATE = 1000;
/** The step sizes Bitbucket Pipelines documents. */
export const BITBUCKET_STEP_SIZES: readonly string[] = [
  "1x",
  "2x",
  "4x",
  "8x",
  "16x",
  "24x",
  "32x",
];

export class CostBitbucketConfigError extends Error {}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,61}$/;

function readWorkspaces(v: unknown): readonly string[] {
  if (v === undefined) return Object.freeze([]);
  if (!Array.isArray(v)) {
    throw new CostBitbucketConfigError(
      "[cost.bitbucket].workspaces must be a list of workspace slugs",
    );
  }
  if (v.length > COST_BITBUCKET_MAX_WORKSPACES) {
    throw new CostBitbucketConfigError(
      `[cost.bitbucket].workspaces: at most ${String(COST_BITBUCKET_MAX_WORKSPACES)}`,
    );
  }
  const seen = new Set<string>();
  for (const w of v as unknown[]) {
    if (typeof w !== "string" || !SLUG_RE.test(w)) {
      throw new CostBitbucketConfigError(
        `[cost.bitbucket].workspaces: ${JSON.stringify(w).slice(0, 64)} is not a workspace slug (lowercase letters, digits, - and _)`,
      );
    }
    if (seen.has(w)) {
      throw new CostBitbucketConfigError(`[cost.bitbucket].workspaces: ${w} is listed twice`);
    }
    seen.add(w);
  }
  return Object.freeze([...seen]);
}

function rate(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > COST_BITBUCKET_MAX_RATE) {
    throw new CostBitbucketConfigError(
      `${what} must be a number from 0 to ${String(COST_BITBUCKET_MAX_RATE)} (a price per minute)`,
    );
  }
  return v;
}

function readSizeRates(v: unknown): readonly (readonly [string, number])[] {
  if (v === undefined) return Object.freeze([]);
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CostBitbucketConfigError(
      '[cost.bitbucket].size_rates must be a table such as { "2x" = 0.02 }',
    );
  }
  const out = Object.entries(v as Record<string, unknown>).map(
    ([size, r]): readonly [string, number] => {
      if (!BITBUCKET_STEP_SIZES.includes(size)) {
        throw new CostBitbucketConfigError(
          `[cost.bitbucket].size_rates: ${JSON.stringify(size).slice(0, 64)} is not a step size (${BITBUCKET_STEP_SIZES.join(", ")})`,
        );
      }
      return Object.freeze([size, rate(r, `[cost.bitbucket].size_rates.${size}`)]);
    },
  );
  out.sort((a, b) => codeUnitCompare(a[0], b[0]));
  return Object.freeze(out);
}

/** `[cost.bitbucket]` from its parsed table. Throws {@link CostBitbucketConfigError}. */
export function readCostBitbucketTable(t: Record<string, unknown>): NimbusCostBitbucketConfig {
  for (const k of Object.keys(t)) {
    if (!["workspaces", "rate_per_minute", "currency", "size_rates"].includes(k)) {
      throw new CostBitbucketConfigError(`[cost.bitbucket]: unknown key "${k}"`);
    }
  }
  const currency = t["currency"] ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new CostBitbucketConfigError(
      "[cost.bitbucket].currency must be a three-letter ISO 4217 code such as USD",
    );
  }
  return Object.freeze({
    workspaces: readWorkspaces(t["workspaces"]),
    ratePerMinute:
      t["rate_per_minute"] === undefined
        ? null
        : rate(t["rate_per_minute"], "[cost.bitbucket].rate_per_minute"),
    currency,
    sizeRates: readSizeRates(t["size_rates"]),
  });
}

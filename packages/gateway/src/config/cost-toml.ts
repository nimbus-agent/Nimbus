/**
 * `[cost]`, `[cost.focus]`, `[cost.github]`, `[cost.gitlab]` (`cost-gitlab-toml.ts`), `[cost.bitbucket]` (`cost-bitbucket-toml.ts`) and `[[cost.rule]]` - the Cost
 * Pack's owner config (Phase 7).
 *
 * ```toml
 * [cost]
 * internal_envs = ["ci", "dev", "test", "staging"]   # the envs `nimbus cost internal` shows
 * authoritative = { aws = "vantage" }                # per provider, the source the views use
 *
 * [cost.focus]
 * dir = "/abs/path/to/exports"                       # imported once a day (new or changed files)
 *
 * [cost.github]
 * orgs = ["acme"]                                    # synced daily from GitHub's billing usage API
 *
 * [cost.aws]
 * export = "s3://bucket/prefix"                      # a FOCUS 1.0 CSV Data Export, synced daily (slice 11a)
 *
 * [[cost.rule]]                                      # ordered, first match wins
 * match = { provider = "aws", tag = { product = "*" } }
 * set = { product = "{tag.product}", env = "{tag.env}" }
 * ```
 *
 * Each key is one line (an inline table for `match`, `set` and `authoritative`), read with Bun's TOML reader
 * section by section. As for every array block, the highest layer that has `[[cost.rule]]` blocks supplies all of
 * them: a role pack's default rules apply until the owner writes their own, which then replace them whole
 * (never interleaved, so first-match order is exactly what one file says). Unlike the other
 * sections, a bad value is NOT a per-key fallback: an unknown key, an unknown placeholder, a malformed rule or a
 * malformed header that names a cost table (`[[cost.rule]`, `[cost`)
 * refuses the whole cost config (`error`, recorded through `sectionFallbackSink`), and the views say so,
 * because a silently dropped rule would move cost to another product without a word.
 */
import { isAbsolute } from "node:path";

import {
  COST_SET_VALUE_RE,
  type CostRule,
  CostRuleError,
  compileCostRule,
} from "../finops/cost-rules.ts";
import {
  CostAwsConfigError,
  DEFAULT_COST_AWS_CONFIG,
  type NimbusCostAwsConfig,
  readCostAwsTable,
} from "./cost-aws-toml.ts";
import {
  CostBitbucketConfigError,
  DEFAULT_COST_BITBUCKET_CONFIG,
  type NimbusCostBitbucketConfig,
  readCostBitbucketTable,
} from "./cost-bitbucket-toml.ts";

import {
  CostGitlabConfigError,
  DEFAULT_COST_GITLAB_CONFIG,
  type NimbusCostGitlabConfig,
  readCostGitlabTable,
} from "./cost-gitlab-toml.ts";
import {
  CostReportConfigError,
  type CostReportDef,
  compileCostReports,
} from "./cost-report-toml.ts";
import { getLayeredConfig, layerReadError, sectionFallbackSink } from "./layered-config.ts";
import type { EffectiveSection } from "./layered-merge.ts";

export interface NimbusCostConfig {
  readonly rules: readonly CostRule[];
  readonly internalEnvs: readonly string[];
  /** Per provider, the source id the views use for it (e.g. `{ aws: "vantage" }`). */
  readonly authoritative: Readonly<Record<string, string>>;
  readonly focusDir: string | null;
  /** `[cost.github] orgs`: the organizations whose billing usage is synced (slice 5); empty = none. */
  readonly githubOrgs: readonly string[];
  /** `[cost.gitlab]`: the groups whose compute minutes are synced, and the owner's rates (slice 8). */
  readonly gitlab: NimbusCostGitlabConfig;
  /** `[cost.bitbucket]`: the workspaces whose Pipelines minutes are synced, and the owner's rates (slice 9). */
  readonly bitbucket: NimbusCostBitbucketConfig;
  /** `[cost.aws]`: the FOCUS Data Export in S3 and the Cost Explorer opt-in (slice 11a; see `cost-aws-toml.ts`). */
  readonly aws: NimbusCostAwsConfig;
  /** `[[cost.report]]` with their `[[cost.report.channel]]` blocks (slice 3; see `cost-report-toml.ts`). */
  readonly reports: readonly CostReportDef[];
  /** Non-null: the report definitions are refused (`reports` is empty); the rules still apply. */
  readonly reportsError: string | null;
  /** Non-null: the cost config is refused (no rules apply) and every view says so. */
  readonly error: string | null;
}

export const DEFAULT_COST_INTERNAL_ENVS: readonly string[] = Object.freeze([
  "ci",
  "dev",
  "test",
  "staging",
]);
export const COST_MAX_RULES = 500;

export const DEFAULT_COST_CONFIG: NimbusCostConfig = Object.freeze({
  rules: Object.freeze([]) as readonly CostRule[],
  internalEnvs: DEFAULT_COST_INTERNAL_ENVS,
  authoritative: Object.freeze({}),
  focusDir: null,
  githubOrgs: Object.freeze([]) as readonly string[],
  gitlab: DEFAULT_COST_GITLAB_CONFIG,
  bitbucket: DEFAULT_COST_BITBUCKET_CONFIG,
  aws: DEFAULT_COST_AWS_CONFIG,
  reports: Object.freeze([]) as readonly CostReportDef[],
  reportsError: null,
  error: null,
});

class CostConfigError extends Error {}

function parseSection(s: EffectiveSection, what: string): Record<string, unknown> {
  // A line the layered reader could not read as `key = value` would otherwise be dropped, silently widening a rule.
  for (const p of s.passthrough) {
    const line = p.raw.trim();
    if (line !== "" && !line.startsWith("#")) {
      throw new CostConfigError(`${what}: not a key = value line: ${line.slice(0, 120)}`);
    }
  }
  const text = s.entries.map((e) => `${e.key} = ${e.valRaw}`).join("\n");
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new CostConfigError(
      `${what}: not valid TOML (${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

function only(table: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(table)) {
    if (!allowed.includes(k)) throw new CostConfigError(`${what}: unknown key "${k}"`);
  }
}

function readCostTable(
  t: Record<string, unknown>,
  draft: { -readonly [K in keyof NimbusCostConfig]: NimbusCostConfig[K] },
): void {
  only(t, ["internal_envs", "authoritative"], "[cost]");
  if (t["internal_envs"] !== undefined) {
    const v = t["internal_envs"];
    if (
      !Array.isArray(v) ||
      v.length === 0 ||
      v.length > 32 ||
      !v.every((x) => typeof x === "string" && COST_SET_VALUE_RE.test(x))
    ) {
      throw new CostConfigError("[cost].internal_envs must be a list of 1 to 32 env names");
    }
    draft.internalEnvs = Object.freeze([...(v as string[])]);
  }
  if (t["authoritative"] !== undefined) {
    const v = t["authoritative"];
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      throw new CostConfigError('[cost].authoritative must be a table such as { aws = "focus" }');
    }
    const out: Record<string, string> = {};
    for (const [provider, source] of Object.entries(v)) {
      if (typeof source !== "string" || !COST_SET_VALUE_RE.test(source)) {
        throw new CostConfigError(`[cost].authoritative.${provider} must be a source id`);
      }
      out[provider] = source;
    }
    draft.authoritative = Object.freeze(out);
  }
}

function readFocusTable(t: Record<string, unknown>): string | null {
  only(t, ["dir"], "[cost.focus]");
  const dir = t["dir"];
  if (dir === undefined) return null;
  if (typeof dir !== "string" || !isAbsolute(dir))
    throw new CostConfigError("[cost.focus].dir must be an absolute path");
  return dir;
}

/** At most this many `[cost.github] orgs`. */
export const COST_GITHUB_MAX_ORGS = 20;
/** A GitHub organization login: letters, digits and single inner hyphens, 1 to 39 characters. */
const GITHUB_ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

function readGithubTable(t: Record<string, unknown>): readonly string[] {
  only(t, ["orgs"], "[cost.github]");
  const v = t["orgs"];
  if (v === undefined) return Object.freeze([]);
  if (!Array.isArray(v)) throw new CostConfigError("[cost.github].orgs must be a list of names");
  if (v.length > COST_GITHUB_MAX_ORGS) {
    throw new CostConfigError(`[cost.github].orgs: at most ${String(COST_GITHUB_MAX_ORGS)}`);
  }
  const seen = new Set<string>();
  for (const o of v as unknown[]) {
    if (typeof o !== "string" || !GITHUB_ORG_RE.test(o)) {
      throw new CostConfigError(
        `[cost.github].orgs: ${JSON.stringify(o).slice(0, 48)} is not a GitHub organization name`,
      );
    }
    const key = o.toLowerCase();
    if (seen.has(key)) throw new CostConfigError(`[cost.github].orgs: ${o} is listed twice`);
    seen.add(key);
  }
  return Object.freeze([...(v as string[])]);
}

type Draft = { -readonly [K in keyof NimbusCostConfig]: NimbusCostConfig[K] };

/** Read one non-rule cost section into the draft; an unknown cost section is a refusal. */
function readPlainSection(s: EffectiveSection & { header: string }, draft: Draft): void {
  if (s.header === "cost" && !s.isArray) readCostTable(parseSection(s, "[cost]"), draft);
  else if (s.header === "cost.focus" && !s.isArray) {
    draft.focusDir = readFocusTable(parseSection(s, "[cost.focus]"));
  } else if (s.header === "cost.github" && !s.isArray) {
    draft.githubOrgs = readGithubTable(parseSection(s, "[cost.github]"));
  } else if (s.header === "cost.gitlab" && !s.isArray) {
    draft.gitlab = readCostGitlabTable(parseSection(s, "[cost.gitlab]"));
  } else if (s.header === "cost.bitbucket" && !s.isArray) {
    draft.bitbucket = readCostBitbucketTable(parseSection(s, "[cost.bitbucket]"));
  } else if (s.header === "cost.aws" && !s.isArray) {
    draft.aws = readCostAwsTable(parseSection(s, "[cost.aws]"));
  } else {
    const shown = s.isArray ? `[[${s.header}]]` : `[${s.header}]`;
    throw new CostConfigError(`unknown section ${shown}`);
  }
}

function compileRules(blocks: readonly EffectiveSection[]): readonly CostRule[] {
  if (blocks.length > COST_MAX_RULES) {
    throw new CostConfigError(`at most ${String(COST_MAX_RULES)} [[cost.rule]] blocks`);
  }
  return Object.freeze(
    blocks.map((b, i) => {
      const t = parseSection(b, `[[cost.rule]] ${String(i + 1)}`);
      only(t, ["match", "set"], `[[cost.rule]] ${String(i + 1)}`);
      return compileCostRule({ match: t["match"], set: t["set"] }, i + 1);
    }),
  );
}

const ARRAY_HEADERS = ["cost.rule", "cost.report", "cost.report.channel"] as const;
type ArrayHeader = (typeof ARRAY_HEADERS)[number];
const isArrayHeader = (h: string): h is ArrayHeader =>
  (ARRAY_HEADERS as readonly string[]).includes(h);

const isCostHeader = (h: string | null): h is string =>
  h === "cost" || (h?.startsWith("cost.") ?? false);

/**
 * A header line the layered reader could not parse (`[[cost.rule]`, `[cost`) that still names a cost table:
 * after the opening brackets, optional spaces and an optional quote, the name `cost` ends there or at `.`,
 * `]`, a quote or a space.
 */
const MALFORMED_COST_HEADER_RE = /^\[{1,2}\s*["']?cost(?:["'\s.\]]|$)/;

function refuseMalformedCostHeader(s: EffectiveSection): void {
  const raw = s.malformed?.trim();
  if (raw !== undefined && MALFORMED_COST_HEADER_RE.test(raw)) {
    throw new CostConfigError(`malformed section header ${raw.slice(0, 120)}`);
  }
}

/**
 * The reports, refused on their own: a bad report or channel leaves `reports` empty with `reportsError` set,
 * and the rules (and every cost view) stay in force.
 */
function compileReportsScoped(
  reportBlocks: readonly EffectiveSection[],
  channelBlocks: readonly EffectiveSection[],
): { reports: readonly CostReportDef[]; reportsError: string | null } {
  try {
    const reports = compileCostReports(
      reportBlocks.map((b, i) => parseSection(b, `[[cost.report]] ${String(i + 1)}`)),
      channelBlocks.map((b, i) => parseSection(b, `[[cost.report.channel]] ${String(i + 1)}`)),
    );
    return { reports, reportsError: null };
  } catch (e) {
    if (e instanceof CostConfigError || e instanceof CostReportConfigError) {
      return { reports: Object.freeze([]), reportsError: e.message };
    }
    throw e;
  }
}

/** The cost config from the effective (layered) sections. Pure. */
export function resolveCostConfig(sections: readonly EffectiveSection[]): NimbusCostConfig {
  const draft: Draft = { ...DEFAULT_COST_CONFIG };
  try {
    const blocks: Record<ArrayHeader, EffectiveSection[]> = {
      "cost.rule": [],
      "cost.report": [],
      "cost.report.channel": [],
    };
    for (const s of sections) {
      refuseMalformedCostHeader(s);
      const header = s.header;
      if (!isCostHeader(header)) continue;
      if (s.isArray && isArrayHeader(header)) blocks[header].push(s);
      else readPlainSection({ ...s, header }, draft);
    }
    draft.rules = compileRules(blocks["cost.rule"]);
    Object.assign(
      draft,
      compileReportsScoped(blocks["cost.report"], blocks["cost.report.channel"]),
    );
    return Object.freeze(draft);
  } catch (e) {
    if (
      e instanceof CostConfigError ||
      e instanceof CostRuleError ||
      e instanceof CostGitlabConfigError ||
      e instanceof CostBitbucketConfigError ||
      e instanceof CostAwsConfigError
    ) {
      return Object.freeze({ ...DEFAULT_COST_CONFIG, error: e.message });
    }
    throw e;
  }
}

/** The cost config over the layered snapshot (packs, team, base, active profile). */
export function loadNimbusCostFromConfigDir(configDir: string): NimbusCostConfig {
  const readError = layerReadError(configDir);
  if (readError !== undefined) return Object.freeze({ ...DEFAULT_COST_CONFIG, error: readError });
  const cfg = resolveCostConfig(getLayeredConfig(configDir).snapshot().doc.sections);
  if (cfg.error !== null) sectionFallbackSink(configDir, "cost")(`refused: ${cfg.error}`);
  else if (cfg.reportsError !== null) {
    sectionFallbackSink(configDir, "cost")(`reports refused: ${cfg.reportsError}`);
  }
  return cfg;
}

// Phase 7 (the Cost Pack): owner-written allocation rules (`[[cost.rule]]`). Each cost line is mapped to a
// product, an environment and optionally a service by the FIRST rule whose every given match key matches;
// a line no rule matches, or whose matched rule cannot produce a safe value, is `unassigned` with the reason.
//
// Confined by static rule D48 (no network, no connector, no model). Pure. Allocation is computed at read time
// from the stored lines and the current rules, so editing a rule re-applies it to the past at once.
//
// Matchers live in one registry (`COST_MATCHERS`) keyed by match field; a new kind (a service-catalog or an
// ownership lookup) is one entry there. Globs know `*` and `?` only and match case-insensitively.
import { type CostLine, setTag, tagOf } from "./cost-line.ts";

export const COST_MATCH_KEYS = [
  "source",
  "provider",
  "sub_account",
  "service",
  "region",
  "resource",
  "repo",
  "workflow",
] as const;
export type CostMatchKey = (typeof COST_MATCH_KEYS)[number];
export const COST_SET_KEYS = ["product", "env", "service"] as const;
export type CostSetKey = (typeof COST_SET_KEYS)[number];

export type CostRuleMatch = Partial<Record<CostMatchKey, string>> & {
  readonly tag?: Readonly<Record<string, string>>;
};
export type CostRuleSet = Partial<Record<CostSetKey, string>>;

export interface CostRule {
  /** 1-based position in the effective rule list (owner layers first). */
  readonly index: number;
  readonly match: CostRuleMatch;
  readonly set: CostRuleSet;
}

export interface CostAllocation {
  readonly product: string | null;
  readonly env: string | null;
  readonly service: string | null;
  /** The 1-based index of the rule that matched, or null. */
  readonly rule: number | null;
  /** Why the line is unassigned; null when its rule produced every value it sets. */
  readonly unassignedReason: string | null;
}

/** What a rule's output must look like after substitution. */
export const COST_SET_VALUE_RE = /^[A-Za-z0-9._:/@+-]{1,64}$/;
const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const FIXED_PLACEHOLDERS = new Set(["repo", "sub_account"]);
const TAG_KEY_RE = /^tag\.([A-Za-z0-9._:/@+-]{1,128})$/;

export class CostRuleError extends Error {
  override readonly name = "CostRuleError";
}

/** A value the charset admits that could still read as a path or a mention is refused too. */
export function isSafeSetValue(v: string): boolean {
  return COST_SET_VALUE_RE.test(v) && !v.includes("..") && !v.startsWith("/") && !v.startsWith("@");
}

/** One glob character as regex source: `*` any run, `?` any one character, anything else literal. */
function globCharSource(c: string): string {
  if (c === "*") return ".*";
  if (c === "?") return ".";
  return c.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const globCache = new Map<string, RegExp>();
export function globMatches(glob: string, value: string): boolean {
  let re = globCache.get(glob);
  if (re === undefined) {
    const body = glob.split("").map(globCharSource).join("");
    re = new RegExp(`^${body}$`, "is");
    if (globCache.size > 1000) globCache.clear();
    globCache.set(glob, re);
  }
  return re.test(value);
}

const matchesAny = (glob: string, ...values: (string | null)[]): boolean =>
  values.some((v) => v !== null && globMatches(glob, v));

/** One matcher per match field. */
export const COST_MATCHERS: Readonly<
  Record<CostMatchKey, (line: CostLine, glob: string) => boolean>
> = {
  source: (l, g) => matchesAny(g, l.source),
  provider: (l, g) => matchesAny(g, l.provider),
  sub_account: (l, g) => matchesAny(g, l.subAccountId, l.subAccountName),
  service: (l, g) => matchesAny(g, l.serviceName),
  region: (l, g) => matchesAny(g, l.regionId),
  resource: (l, g) => matchesAny(g, l.resourceId, l.resourceName),
  repo: (l, g) => matchesAny(g, l.repo),
  workflow: (l, g) => matchesAny(g, l.workflow),
};

function ruleMatches(line: CostLine, rule: CostRule): boolean {
  for (const key of COST_MATCH_KEYS) {
    const glob = rule.match[key];
    if (glob !== undefined && !COST_MATCHERS[key](line, glob)) return false;
  }
  for (const [k, glob] of Object.entries(rule.match.tag ?? {})) {
    const v = tagOf(line.tags, k);
    if (v === undefined || !globMatches(glob, v)) return false;
  }
  return true;
}

function placeholderValue(line: CostLine, name: string): string | null {
  if (name === "repo") return line.repo;
  if (name === "sub_account") return line.subAccountId;
  const m = TAG_KEY_RE.exec(name);
  return m?.[1] === undefined ? null : (tagOf(line.tags, m[1]) ?? null);
}

/** Substitute one set value; a string result, or the unassigned reason. */
function substitute(
  line: CostLine,
  rule: CostRule,
  key: CostSetKey,
  template: string,
): { value: string } | { reason: string } {
  let reason: string | null = null;
  const value = template.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const v = placeholderValue(line, name);
    if (v === null || v === "")
      reason = `rule ${String(rule.index)}: ${key}: ${whole} is empty on this line`;
    return v ?? "";
  });
  if (reason !== null) return { reason };
  if (!isSafeSetValue(value)) {
    return {
      reason: `rule ${String(rule.index)}: ${key}: the value "${value.slice(0, 64)}" is not allowed (letters, digits and . _ : / @ + - only, 1 to 64, no "..")`,
    };
  }
  return { value };
}

const NO_MATCH: CostAllocation = Object.freeze({
  product: null,
  env: null,
  service: null,
  rule: null,
  unassignedReason: "no rule matched",
});

export function allocate(line: CostLine, rules: readonly CostRule[]): CostAllocation {
  const rule = rules.find((r) => ruleMatches(line, r));
  if (rule === undefined) return NO_MATCH;
  const out: Record<CostSetKey, string | null> = { product: null, env: null, service: null };
  for (const key of COST_SET_KEYS) {
    const template = rule.set[key];
    if (template === undefined) continue;
    const r = substitute(line, rule, key, template);
    if ("reason" in r) {
      return {
        product: null,
        env: null,
        service: null,
        rule: rule.index,
        unassignedReason: r.reason,
      };
    }
    out[key] = r.value;
  }
  return { ...out, rule: rule.index, unassignedReason: null };
}

function asRecord(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v))
    throw new CostRuleError(`${what} must be a table`);
  return v as Record<string, unknown>;
}

function asString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 256) {
    throw new CostRuleError(`${what} must be a string of 1 to 256 characters`);
  }
  return v;
}

function checkTemplate(template: string, what: string): void {
  const names = [...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? "");
  if (names.length > 1) throw new CostRuleError(`${what}: at most one placeholder is allowed`);
  for (const n of names) {
    if (!FIXED_PLACEHOLDERS.has(n) && !TAG_KEY_RE.test(n)) {
      throw new CostRuleError(
        `${what}: unknown placeholder {${n}} (known: {tag.<key>}, {repo}, {sub_account})`,
      );
    }
  }
  const literal = template.replace(PLACEHOLDER_RE, "x");
  if (!isSafeSetValue(literal) || /[{}]/.test(literal)) {
    throw new CostRuleError(
      `${what}: "${template.slice(0, 64)}" is not allowed (letters, digits and . _ : / @ + - only)`,
    );
  }
}

/** Validate one `[[cost.rule]]` table as read from TOML. Throws {@link CostRuleError} naming the problem. */
export function compileCostRule(
  raw: { readonly match?: unknown; readonly set?: unknown },
  index: number,
): CostRule {
  const at = `rule ${String(index)}`;
  const match: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(asRecord(raw.match, `${at}: match`))) {
    if (k === "tag") {
      const tags: Record<string, string> = {};
      for (const [tk, tv] of Object.entries(asRecord(v, `${at}: match.tag`))) {
        setTag(tags, tk, asString(tv, `${at}: match.tag.${tk}`));
      }
      match["tag"] = tags;
    } else if ((COST_MATCH_KEYS as readonly string[]).includes(k)) {
      match[k] = asString(v, `${at}: match.${k}`);
    } else {
      throw new CostRuleError(
        `${at}: unknown match key "${k}" (known: ${[...COST_MATCH_KEYS, "tag"].join(", ")})`,
      );
    }
  }
  const set: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(raw.set, `${at}: set`))) {
    if (!(COST_SET_KEYS as readonly string[]).includes(k)) {
      throw new CostRuleError(`${at}: unknown set key "${k}" (known: ${COST_SET_KEYS.join(", ")})`);
    }
    const s = asString(v, `${at}: set.${k}`);
    checkTemplate(s, `${at}: ${k}`);
    set[k] = s;
  }
  if (Object.keys(set).length === 0)
    throw new CostRuleError(`${at}: sets nothing (set product, env or service)`);
  return { index, match: match as CostRuleMatch, set: set as CostRuleSet };
}

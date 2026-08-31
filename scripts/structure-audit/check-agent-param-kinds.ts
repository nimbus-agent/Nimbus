#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_PARAM_KINDS,
  type ParamKind,
} from "../../packages/gateway/src/ipc/agent-param-kinds.ts";
import { EXTERNAL_AGENT_NAMES } from "../../packages/gateway/src/ipc/agents-rpc.ts";
import { REPO_ROOT } from "./lib.ts";

export const AGENTS_RPC_PATH = join(
  REPO_ROOT,
  "packages",
  "gateway",
  "src",
  "ipc",
  "agents-rpc.ts",
);

/** A top-level `function require<Something>(` header, at column 0. */
const VALIDATOR_HEADER_RE = /^function (require\w+)\(/;

/** `typeof p.field !== "kind"` or `typeof p.field === "kind"`. */
const DOT_TYPEOF_RE = /typeof\s+p\.(\w+)\s*(?:!==|===)\s*"(\w+)"/g;
/** `typeof p["field"] !== "kind"` or `typeof p["field"] === "kind"` — `janitor`'s bracket form. */
const BRACKET_TYPEOF_RE = /typeof\s+p\["(\w+)"\]\s*(?:!==|===)\s*"(\w+)"/g;

const TYPEOF_TO_KIND: Readonly<Record<string, ParamKind>> = Object.freeze({
  string: "string",
  number: "number",
  boolean: "boolean",
  // `typeof` never yields "stringArray" — arrays are `typeof "object"` — so that ParamKind is
  // structurally unrecoverable by this line-walker no matter the form. `ghost.namespaces` &c. are
  // in that boat too, for the same underlying reason (see the doc comment on parseValidatorFields).
});

/**
 * Validator function names that do not follow the `require<Agent>Params` shape the generic
 * deriver below relies on — verified against the tree, not guessed:
 *  - `requireFileParam` (singular, no "Params" suffix) backs BOTH `ghost` and `conflicts`
 *    (`handleGhost` and `handleConflicts` both call it).
 *  - `requireWhyParams` backs `why`. It already derives correctly by the generic rule below, but
 *    is listed explicitly anyway — it is the one other validator name this task's brief calls out
 *    by name, and an override entry survives a future rename of the generic derivation logic that
 *    a name coincidence would not.
 */
const VALIDATOR_AGENT_OVERRIDES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  requireFileParam: Object.freeze(["ghost", "conflicts"]),
  requireWhyParams: Object.freeze(["why"]),
});

/**
 * `requireExpertParams` -> `["expert"]`. Returns `[]` for a validator this line-walker cannot
 * (and, per `VALIDATOR_AGENT_OVERRIDES`, does not need to) map to an agent — e.g. `requireEpicRef`,
 * `requireWhyRefParams`, or any of the four permission-internal validators (`preflight`,
 * `negotiate`, `premortem`, and `why`'s ref-only inner form) that `AGENT_PARAM_KINDS` deliberately
 * excludes. `checkAgentParamKinds` silently skips fields attributed to an unmapped agent.
 */
function deriveAgentNames(validatorName: string): readonly string[] {
  const override = VALIDATOR_AGENT_OVERRIDES[validatorName];
  if (override !== undefined) return override;
  const m = /^require(\w+)Params$/.exec(validatorName);
  if (m === null) return [];
  const middle = m[1];
  if (middle === undefined || middle.length === 0) return [];
  return [middle.charAt(0).toLowerCase() + middle.slice(1)];
}

export interface ParsedValidator {
  readonly agent: string | readonly string[];
  readonly fields: Readonly<Record<string, ParamKind>>;
}

/**
 * Walk `agents-rpc.ts` line by line, tracking the current top-level `function require<X>(` header
 * and a deliberately naive running brace balance — every `{`/`}` CHARACTER counts, comments and
 * template-literal `${…}` interpolations included — to find where that function's body ends. Every
 * `typeof p.field`/`typeof p["field"]` comparison inside that span, in either polarity, is recorded
 * against it. This is a line-walker, not a parser: it does not tokenize strings or comments, and it
 * relies on every `{`/`}` in the file occurring in a properly nested pair (true of this file's
 * style today — template interpolations are the only source of "incidental" braces, and each `${`
 * is always closed on the same line). CODE REVIEW NOTE: a future edit that puts an unbalanced brace
 * inside a string or comment within one of these functions (e.g. a stray closing brace in an error
 * message) would desynchronize this walker's idea of where the function ends; nothing today guards
 * against that beyond this comment and the lint rules that already discourage that shape of literal.
 *
 * This walker CANNOT see a field validated via a local alias (`janitor.idleDays`, checked as
 * `typeof idleDaysRaw`, never `typeof p.idleDays`), a field with no `typeof` check at all
 * (`janitor.allowGaps`, `decisions.explain`), or a field validated inside a DIFFERENT function that
 * the owning validator merely delegates to — `ghost`/`conflicts`/`huddle`'s `namespace`/
 * `namespaces` (checked by the shared `parseNamespaces` helper, on a loop variable, never on
 * `p.namespace`) and `why`'s `ref`/`line` (checked by `requireWhyRefParams`, a function
 * `requireWhyParams` calls rather than inlines). None of that is a bug to work around: see
 * `checkAgentParamKinds`'s doc comment for why the comparison this feeds is one-directional, which
 * is exactly what makes each of those blind spots harmless rather than a false negative that
 * matters.
 */
export function parseValidatorFields(source: string): Record<string, ParsedValidator> {
  const lines = source.split("\n");
  const result: Record<string, ParsedValidator> = {};
  let currentName: string | null = null;
  let depth = 0;
  let fields: Record<string, ParamKind> = {};

  const finish = (): void => {
    if (currentName === null) return;
    const agents = deriveAgentNames(currentName);
    result[currentName] = {
      agent: agents.length === 1 ? (agents[0] as string) : agents,
      fields,
    };
    currentName = null;
    fields = {};
  };

  for (const line of lines) {
    if (currentName === null) {
      const header = VALIDATOR_HEADER_RE.exec(line);
      if (header === null) continue;
      currentName = header[1] as string;
      depth = 0;
      fields = {};
    }

    DOT_TYPEOF_RE.lastIndex = 0;
    for (let m = DOT_TYPEOF_RE.exec(line); m !== null; m = DOT_TYPEOF_RE.exec(line)) {
      const kind = TYPEOF_TO_KIND[m[2] as string];
      if (kind !== undefined) fields[m[1] as string] = kind;
    }
    BRACKET_TYPEOF_RE.lastIndex = 0;
    for (let m = BRACKET_TYPEOF_RE.exec(line); m !== null; m = BRACKET_TYPEOF_RE.exec(line)) {
      const kind = TYPEOF_TO_KIND[m[2] as string];
      if (kind !== undefined) fields[m[1] as string] = kind;
    }

    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) finish();
  }
  finish();
  return result;
}

/**
 * The count a healthy, unreshaped `agents-rpc.ts` parse should clear: eleven externally-permitted
 * agents (see `AGENT_PARAM_KINDS`'s own doc comment) minus one, because `ghost` and `conflicts`
 * share `requireFileParam`.
 *
 * That arithmetic (11 - 1 = 10) is NOT the same number as "how many `function require...(`
 * headers `parseValidatorFields` finds in the file" — those are two different counts that this
 * comment used to read as if they were one. The file has FIFTEEN such headers today (verified by
 * grep, not assumed): the ten counted above for the eleven externally-permitted agents, plus five
 * more for agents/helpers this floor does not cover — `requirePreflightParams` and
 * `requirePremortemParams` (permitted internally but excluded from every EXTERNAL surface,
 * `EXTERNAL_EXCLUDED_AGENT_METHODS`), `requireNegotiateParams` (excluded the same way), and two
 * sub-parsers that are not themselves one agent's whole validator — `requireWhyRefParams` (feeds
 * `requireWhyParams`) and `requireEpicRef` (feeds ownership parsing). `VALIDATOR_FLOOR` is
 * deliberately the SMALLER, externally-scoped number: this floor exists to catch `agents-rpc.ts`
 * losing recognisable structure for the agents a chat/HTTP caller can actually reach, not to
 * assert the total header count, which would break every time an internal-only agent gained or
 * lost a helper function with no externally-visible change at all.
 *
 * This is the ACTUAL gate `checkAgentParamKinds` compares against — not just a number interpolated
 * into a message — so a partial restructure that leaves, say, 3 or 9 validators recognisable also
 * degrades to indeterminate, not just a parse that recognises zero.
 */
export const VALIDATOR_FLOOR = 10;

export type ParamKindsFinding =
  | { readonly rule: "indeterminate"; readonly detail: string }
  | { readonly rule: "missing-in-map"; readonly snippet: string; readonly detail: string }
  | { readonly rule: "uncovered-agent"; readonly snippet: string; readonly detail: string };

/**
 * Compares each parsed validator's type-checked fields against `AGENT_PARAM_KINDS`, in ONE
 * DIRECTION ONLY: every field a validator type-checks must have a matching, same-kind entry in
 * `AGENT_PARAM_KINDS` for its agent(s). The REVERSE IS DELIBERATELY NOT CHECKED — a map entry with
 * no matching `typeof` in the validator is legitimate, not drift. Verified against the real file,
 * that is not a narrow exemption list: at minimum `janitor.allowGaps`, `janitor.idleDays`,
 * `decisions.explain`, `why.ref`, `why.line`, and every `namespace`/`namespaces` field on `ghost`/
 * `conflicts`/`huddle` are map entries this line-walker cannot ever see checked (see
 * `parseValidatorFields`'s doc comment for why each is structurally invisible to it). Checking the
 * reverse direction would flag all of those, on every run, on a file that has not drifted at all —
 * "permanent, unfixable drift" is exactly the failure mode this function exists to avoid. DO NOT
 * "tighten" this into a two-directional (or `toEqual`-shaped) comparison; the fix for a field this
 * parser cannot see is widening `parseValidatorFields`, not making this function pretend the field
 * doesn't exist in the map.
 *
 * A `parsed` with FEWER THAN `VALIDATOR_FLOOR` validators (not only zero — a partial restructure
 * that leaves, say, 3 or 9 recognisable is the realistic failure mode, not just a parse that finds
 * nothing at all) returns a single `indeterminate` finding instead of walking the comparison. This
 * bound is intentionally on the SAFE side of asymmetric: the comparison below is additive (it only
 * ever iterates the fields a validator was actually found to check) and never iterates
 * `AGENT_PARAM_KINDS`'s own keys, so even without this floor a partial parse could only ever
 * under-report drift, never manufacture a false one. The floor exists to make that degradation
 * visible (a warning, not silence) rather than to prevent a false-positive flood that the
 * one-directional design already rules out.
 *
 * Above the floor, this also asserts that every `EXTERNAL_AGENT_NAMES` entry — the independently
 * derived, served set of externally-permitted agents, not `AGENT_PARAM_KINDS`'s own key list —
 * resolved to at least one parsed validator. `VALIDATOR_AGENT_OVERRIDES` and the generic
 * `require<Agent>Params` deriver both need manual upkeep for an agent whose validator does not
 * follow the `handle<X>` -> `require<X>Params` convention; nothing else forces a new entry when one
 * is added, so an `uncovered-agent` finding is what catches a 12th agent silently falling through
 * that convention rather than the guard quietly checking fewer agents than it claims to.
 */
export function checkAgentParamKinds(
  parsed: Readonly<Record<string, ParsedValidator>>,
): ParamKindsFinding[] {
  const validatorNames = Object.keys(parsed);
  if (validatorNames.length < VALIDATOR_FLOOR) {
    return [
      {
        rule: "indeterminate",
        detail: `found ${validatorNames.length} validators (a healthy agents-rpc.ts parse finds at least ${VALIDATOR_FLOOR}) — treating this parse as indeterminate rather than reporting drift`,
      },
    ];
  }

  const findings: ParamKindsFinding[] = [];
  const coveredAgents = new Set<string>();
  for (const validator of Object.values(parsed)) {
    const agents = Array.isArray(validator.agent) ? validator.agent : [validator.agent];
    for (const agent of agents) {
      coveredAgents.add(agent);
      const known = AGENT_PARAM_KINDS[agent];
      if (known === undefined) continue; // not one of the eleven externally-permitted agents
      for (const [field, kind] of Object.entries(validator.fields)) {
        const mapKind = known[field];
        if (mapKind === kind) continue;
        const snippet = `${agent}.${field}`;
        const detail =
          mapKind === undefined
            ? `${snippet} is type-checked as "${kind}" in agents-rpc.ts but has no entry in AGENT_PARAM_KINDS`
            : `${snippet} is type-checked as "${kind}" in agents-rpc.ts but AGENT_PARAM_KINDS declares "${mapKind}"`;
        findings.push({ rule: "missing-in-map", snippet, detail });
      }
    }
  }

  for (const agent of EXTERNAL_AGENT_NAMES) {
    if (coveredAgents.has(agent)) continue;
    findings.push({
      rule: "uncovered-agent",
      snippet: agent,
      detail: `${agent} is one of EXTERNAL_AGENT_NAMES but no parsed validator in agents-rpc.ts resolved to it — VALIDATOR_AGENT_OVERRIDES or the generic require<Agent>Params derivation likely needs a new entry, or the agent genuinely takes no params, in which case add it to an exempt list`,
    });
  }

  return findings;
}

/**
 * Print each finding and return the process exit code. An `indeterminate` finding is a warning,
 * never a build failure — see `checkAgentParamKinds`'s doc comment for why a near-empty parse must
 * not be treated as proof of drift.
 */
export function report(findings: readonly ParamKindsFinding[]): number {
  let exitCode = 0;
  for (const f of findings) {
    if (f.rule === "indeterminate") {
      console.warn(`::warning::agent-param-kinds: ${f.detail}`);
      continue;
    }
    console.error(`::error::agent-param-kinds: ${f.detail}`);
    exitCode = 1;
  }
  if (exitCode === 0 && findings.length === 0) {
    console.log("agent-param-kinds: AGENT_PARAM_KINDS matches every type-checked validator field");
  }
  return exitCode;
}

if (import.meta.main) {
  const source = readFileSync(AGENTS_RPC_PATH, "utf8");
  process.exit(report(checkAgentParamKinds(parseValidatorFields(source))));
}

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AGENT_PARAM_KINDS } from "../../packages/gateway/src/ipc/agent-param-kinds.ts";
import {
  AGENTS_RPC_PATH,
  checkAgentParamKinds,
  type ParsedValidator,
  parseValidatorFields,
  VALIDATOR_FLOOR,
} from "./check-agent-param-kinds.ts";

/**
 * A synthetic `parsed` map that mirrors `AGENT_PARAM_KINDS` exactly — one entry per real agent,
 * fields copied verbatim — so it clears `VALIDATOR_FLOOR` (11 real agents >= 10) and covers every
 * `EXTERNAL_AGENT_NAMES` entry BY CONSTRUCTION. Tests that want to exercise one specific drift
 * scenario clone this and mutate exactly one agent's entry, so neither the floor guard nor the new
 * `uncovered-agent` check (fix 4) produces incidental noise in an otherwise-targeted assertion.
 */
function fullCoverageBaseline(): Record<string, ParsedValidator> {
  const out: Record<string, ParsedValidator> = {};
  for (const [agent, fields] of Object.entries(AGENT_PARAM_KINDS)) {
    out[`synthetic_${agent}`] = { agent, fields: { ...fields } };
  }
  return out;
}

function missingInMapSnippets(v: ReturnType<typeof checkAgentParamKinds>): (string | undefined)[] {
  return v.map((x) => (x.rule === "missing-in-map" ? x.snippet : undefined));
}

test("flags a validator field with no entry in the kinds map", () => {
  const parsed = fullCoverageBaseline();
  parsed["synthetic_expert"] = {
    agent: "expert",
    fields: { topicOrFile: "string", limit: "number", newField: "string" },
  };
  const v = checkAgentParamKinds(parsed);
  expect(missingInMapSnippets(v)).toContain("expert.newField");
});

/**
 * The task brief's first draft of this test asked for the OPPOSITE assertion — "flags a kinds-map
 * field the validator does not have" (i.e. `.toContain("expert.limit")` here). That is the
 * equality-check anti-pattern `checkAgentParamKinds`'s own doc comment warns against: verified
 * against the real file, at least eleven real `AGENT_PARAM_KINDS` fields
 * (`janitor.allowGaps`/`idleDays`, `decisions.explain`, `why.ref`/`line`, and every
 * `namespace`/`namespaces` field on `ghost`/`conflicts`/`huddle`) have no matching `typeof` this
 * line-walker can ever see, so checking that direction would flag all of them, forever, on a file
 * that has not drifted. This test locks in the ACTUAL, documented one-directional bound instead —
 * a map field the validator's parse doesn't show (like `limit` here) is legitimate and must never
 * be reported.
 */
test("does NOT flag a map field the validator's parse does not show (one-directional by design)", () => {
  const parsed = fullCoverageBaseline();
  parsed["synthetic_expert"] = { agent: "expert", fields: { topicOrFile: "string" } };
  const v = checkAgentParamKinds(parsed);
  expect(missingInMapSnippets(v)).not.toContain("expert.limit");
});

test("THE GUARD IS NOT INERT: a realistic parse of the real file finds fields", () => {
  // The failure mode this test exists for: a parser that matches nothing passes every other
  // assertion in this file. Imports VALIDATOR_FLOOR rather than hardcoding 10, so this assertion
  // cannot silently drift from the constant the audit itself gates on.
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(VALIDATOR_FLOOR);
  expect(parsed["requireExpertParams"]?.fields).toMatchObject({ topicOrFile: "string" });
});

test("an empty parse degrades to indeterminate, never a flood of false drift", () => {
  // Mirrors the codebase's existing indeterminate convention (`_gh-audit.ts`'s
  // `classifyReadFailure`, `_release-train-core.ts`'s `EdgeVerdict`): a read/parse that came back
  // suspiciously empty is a reason to distrust the CHECK, not a reason to report every declared
  // field as missing.
  const v = checkAgentParamKinds({});
  expect(v).toEqual([{ rule: "indeterminate", detail: expect.stringContaining("0 validators") }]);
});

test("a partial restructure below VALIDATOR_FLOOR is ALSO indeterminate, not partial drift", () => {
  // The realistic failure mode the floor exists for is not "the parser found literally nothing" —
  // it's a reshape that leaves a handful of validators recognisable. One less than the floor must
  // still degrade to indeterminate rather than comparing whatever fragment it found.
  const parsed = fullCoverageBaseline();
  const keys = Object.keys(parsed);
  expect(keys.length).toBeGreaterThan(VALIDATOR_FLOOR - 1);
  for (const key of keys.slice(VALIDATOR_FLOOR - 1)) delete parsed[key];
  expect(Object.keys(parsed).length).toBe(VALIDATOR_FLOOR - 1);

  const v = checkAgentParamKinds(parsed);
  expect(v).toEqual([
    {
      rule: "indeterminate",
      detail: expect.stringContaining(`${VALIDATOR_FLOOR - 1} validators`),
    },
  ]);
});

test("exactly VALIDATOR_FLOOR validators is enough to compare, not indeterminate", () => {
  const parsed = fullCoverageBaseline();
  const keys = Object.keys(parsed);
  expect(keys.length).toBeGreaterThanOrEqual(VALIDATOR_FLOOR);
  for (const key of keys.slice(VALIDATOR_FLOOR)) delete parsed[key];
  expect(Object.keys(parsed).length).toBe(VALIDATOR_FLOOR);

  // Dropping one real agent's entry to land exactly on the floor means that agent is now
  // uncovered — expected, and exercised on its own in the uncovered-agent test below. Assert only
  // that the floor itself did not fire.
  const v = checkAgentParamKinds(parsed);
  expect(v.some((f) => f.rule === "indeterminate")).toBe(false);
});

test("parseValidatorFields maps requireFileParam to BOTH ghost and conflicts", () => {
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  const fileParam = parsed["requireFileParam"];
  expect(fileParam?.agent).toEqual(["ghost", "conflicts"]);
  expect(fileParam?.fields).toMatchObject({ file: "string" });
});

test("checkAgentParamKinds against the real file reports no drift", () => {
  // The end-to-end property the red-prove step (task brief Step 4) exercises manually: the real
  // file, parsed for real, and compared against the real (unmodified) AGENT_PARAM_KINDS, is clean
  // — no missing-in-map drift, and (fix 4) no agent left uncovered.
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  expect(checkAgentParamKinds(parsed)).toEqual([]);
});

test("flags a kind mismatch, not just a missing field", () => {
  const parsed = fullCoverageBaseline();
  parsed["synthetic_expert"] = { agent: "expert", fields: { topicOrFile: "number" } };
  const v = checkAgentParamKinds(parsed);
  expect(v).toEqual([
    {
      rule: "missing-in-map",
      snippet: "expert.topicOrFile",
      detail: expect.stringContaining('AGENT_PARAM_KINDS declares "string"'),
    },
  ]);
});

test("silently skips an agent AGENT_PARAM_KINDS does not externally permit", () => {
  // `preflight` is real (requirePreflightParams exists) but deliberately excluded from
  // AGENT_PARAM_KINDS (see its doc comment) — a validator field for it must never be reported as
  // "missing from the map", because it was never supposed to be there. Layered on the full-coverage
  // baseline so this extra, unmapped entry is the only thing under test.
  const parsed = fullCoverageBaseline();
  parsed["requirePreflightParams"] = { agent: "preflight", fields: { ref: "string" } };
  expect(checkAgentParamKinds(parsed)).toEqual([]);
});

/**
 * Fix 4: closes the "a 12th agent could be silently uncovered" gap structurally. `why` is dropped
 * from the baseline (not padded back in) to prove the assertion actually fires — the same
 * red-prove discipline as the main missing-in-map guard, just aimed at the coverage check instead
 * of the field-kind comparison.
 */
test("flags an EXTERNAL_AGENT_NAMES entry that no validator resolved to", () => {
  const parsed = fullCoverageBaseline();
  delete parsed["synthetic_why"];
  const v = checkAgentParamKinds(parsed);
  expect(v).toContainEqual({
    rule: "uncovered-agent",
    snippet: "why",
    detail: expect.stringContaining("why is one of EXTERNAL_AGENT_NAMES"),
  });
  // Every OTHER real agent is still covered by the baseline, so `why` must be the only omission.
  expect(v.filter((f) => f.rule === "uncovered-agent").map((f) => f.snippet)).toEqual(["why"]);
});

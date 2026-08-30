import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  AGENTS_RPC_PATH,
  checkAgentParamKinds,
  parseValidatorFields,
} from "./check-agent-param-kinds.ts";

test("flags a validator field with no entry in the kinds map", () => {
  const v = checkAgentParamKinds({
    requireExpertParams: {
      agent: "expert",
      fields: { topicOrFile: "string", limit: "number", newField: "string" },
    },
  });
  expect(v.map((x) => (x.rule === "missing-in-map" ? x.snippet : undefined))).toContain(
    "expert.newField",
  );
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
  const v = checkAgentParamKinds({
    requireExpertParams: { agent: "expert", fields: { topicOrFile: "string" } },
  });
  expect(v.map((x) => (x.rule === "missing-in-map" ? x.snippet : undefined))).not.toContain(
    "expert.limit",
  );
});

test("THE GUARD IS NOT INERT: a realistic parse of the real file finds fields", () => {
  // The failure mode this test exists for: a parser that matches nothing passes every other
  // assertion in this file.
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(10);
  expect(parsed["requireExpertParams"]?.fields).toMatchObject({ topicOrFile: "string" });
});

test("an empty/near-empty parse degrades to indeterminate, never a flood of false drift", () => {
  // Mirrors the codebase's existing indeterminate convention (`_gh-audit.ts`'s
  // `classifyReadFailure`, `_release-train-core.ts`'s `EdgeVerdict`): a read/parse that came back
  // suspiciously empty is a reason to distrust the CHECK, not a reason to report every declared
  // field as missing. A future `agents-rpc.ts` reshape that this line-walker no longer recognizes
  // must not manufacture a "your map drifted" finding for every one of the eleven agents at once.
  const v = checkAgentParamKinds({});
  expect(v).toEqual([{ rule: "indeterminate", detail: expect.stringContaining("0 validators") }]);
});

test("parseValidatorFields maps requireFileParam to BOTH ghost and conflicts", () => {
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  const fileParam = parsed["requireFileParam"];
  expect(fileParam?.agent).toEqual(["ghost", "conflicts"]);
  expect(fileParam?.fields).toMatchObject({ file: "string" });
});

test("checkAgentParamKinds([]) against the real file reports no drift", () => {
  // The end-to-end property the red-prove step (task brief Step 4) exercises manually: the real
  // file, parsed for real, and compared against the real (unmodified) AGENT_PARAM_KINDS, is clean.
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  expect(checkAgentParamKinds(parsed)).toEqual([]);
});

test("flags a kind mismatch, not just a missing field", () => {
  const v = checkAgentParamKinds({
    requireExpertParams: { agent: "expert", fields: { topicOrFile: "number" } },
  });
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
  // "missing from the map", because it was never supposed to be there.
  const v = checkAgentParamKinds({
    requirePreflightParams: { agent: "preflight", fields: { ref: "string" } },
  });
  expect(v).toEqual([]);
});

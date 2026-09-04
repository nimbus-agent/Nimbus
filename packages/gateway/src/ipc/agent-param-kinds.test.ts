import { describe, expect, test } from "bun:test";
import { AGENT_PARAM_KINDS } from "./agent-param-kinds.ts";

describe("agent param kinds", () => {
  test("expert's entire declaration is two fields", () => {
    expect(AGENT_PARAM_KINDS["expert"]).toEqual({ topicOrFile: "string", limit: "number" });
  });

  test("minConfidence is a number — the float that has no isInteger guard upstream", () => {
    expect(AGENT_PARAM_KINDS["decisions"]?.["minConfidence"]).toBe("number");
  });

  test("namespaces is the only array field", () => {
    const arrays = Object.entries(AGENT_PARAM_KINDS).flatMap(([a, fields]) =>
      Object.entries(fields)
        .filter(([, k]) => k === "stringArray")
        .map(([f]) => `${a}.${f}`),
    );
    // FIX 5 (whole-branch review): `.every(...)` on an empty array is vacuously `true` — without
    // this, a future change that removed every `stringArray` field entirely would still pass this
    // test. The real claim is "there are exactly three (ghost/conflicts/huddle's `namespaces`),
    // and every one of them is `.namespaces`", so the count has to be pinned too.
    expect(arrays).toHaveLength(3);
    expect(arrays.every((x) => x.endsWith(".namespaces"))).toBe(true);
  });

  // Exactly TWO booleans are in scope, and both belong to PERMITTED agents. `premortem`'s
  // `repropose` is the only EXCLUDED one. An earlier draft of this plan asserted zero booleans;
  // that was wrong and would have failed on arrival.
  test("the two in-scope boolean fields are declared", () => {
    const bools = Object.entries(AGENT_PARAM_KINDS).flatMap(([agent, fields]) =>
      Object.entries(fields)
        .filter(([, k]) => k === "boolean")
        .map(([f]) => `${agent}.${f}`),
    );
    expect(bools.sort()).toEqual(["decisions.explain", "janitor.allowGaps"]);
  });
});

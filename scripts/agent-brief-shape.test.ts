import { describe, expect, test } from "bun:test";
import snapshot from "./agent-brief-shape.snapshot.json" with { type: "json" };
import { briefShapeSignature } from "./agent-brief-shape.ts";
import { generateAgentBriefFixtures } from "./gen-agent-brief-fixtures.ts";

/**
 * Drift gate for the `agents.*` wire contract.
 *
 * `@nimbus-dev/client` validates `<agent>.briefReady` against a fixture generated
 * from this repo. Nothing linked the two: change a brief shape here and the
 * client keeps validating the old contract, both sides green, until someone
 * regenerates by hand. This fails on the PR that changes the shape.
 *
 * It is also *deeper* than the client-side gate, which is envelope-level plus one
 * key per agent and provably misses `gaps[]` element shape (see the client's
 * `test/fixtures/README.md`). The signature here walks the whole payload.
 *
 * WHEN THIS FAILS: the gateway's brief shape changed. That may be entirely
 * intentional — but it is a breaking wire change for every client. Update this
 * snapshot AND regenerate the client's fixture in the same change:
 *
 *   bun run scripts/gen-agent-brief-fixtures.ts > agent-briefs.json
 *   cp agent-briefs.json ../nimbus-client/test/fixtures/agent-briefs.json
 *
 * Do not update the snapshot alone — that silences the gate and leaves the
 * client validating a contract the gateway no longer speaks.
 */

const committed = snapshot as Record<string, readonly string[]>;

describe("agents.* brief shape", () => {
  test("every agent still emits a brief", async () => {
    const fixtures = await generateAgentBriefFixtures();
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(committed).sort());
  });

  test("no agent's payload shape has drifted from the snapshot", async () => {
    const fixtures = await generateAgentBriefFixtures();
    for (const agent of Object.keys(committed).sort()) {
      const actual = briefShapeSignature(fixtures[agent]);
      // Compared per agent so a failure names which one drifted.
      expect({ agent, shape: actual }).toEqual({ agent, shape: [...(committed[agent] ?? [])] });
    }
  });
});

describe("briefShapeSignature", () => {
  test("records paths and types, discarding values", () => {
    expect(briefShapeSignature({ a: 1, b: "x" })).toEqual([".a:number", ".b:string"]);
  });

  test("distinguishes null from a missing key", () => {
    expect(briefShapeSignature({ a: null })).toEqual([".a:null"]);
    expect(briefShapeSignature({})).toEqual([]);
  });

  test("descends into array elements — the depth the client gate lacks", () => {
    expect(briefShapeSignature({ gaps: [{ category: "x", detail: "y" }] })).toEqual([
      ".gaps[].category:string",
      ".gaps[].detail:string",
    ]);
  });

  test("marks an empty array rather than inventing an element type", () => {
    expect(briefShapeSignature({ gaps: [] })).toEqual([".gaps[]:empty"]);
  });

  test("a renamed field changes the signature", () => {
    expect(briefShapeSignature({ ranked: [] })).not.toEqual(briefShapeSignature({ experts: [] }));
  });

  test("a retyped field changes the signature", () => {
    expect(briefShapeSignature({ modifiedAt: 1 })).not.toEqual(
      briefShapeSignature({ modifiedAt: "1" }),
    );
  });
});

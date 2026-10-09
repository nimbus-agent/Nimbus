import { describe, expect, test } from "bun:test";
import { collectLaneCensus } from "../check-index-lane-coverage.ts";
import type { LaneExemption } from "./exemptions.ts";
import { evaluateLaneGate } from "./gate.ts";

const W = {
  relPath: "packages/gateway/src/connectors/pd.ts",
  contents: 'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { status: 1 } });',
};
const R = (body: string) => ({ relPath: "packages/gateway/src/agents/r.ts", contents: body });
const dead = R(
  "db.query(`SELECT 1 FROM item WHERE type = 'incident' AND json_extract(metadata, '$.ghost') = 1`);",
);
const ex = (key: string, extra: Partial<LaneExemption> = {}): LaneExemption => ({
  file: "packages/gateway/src/agents/r.ts",
  key,
  category: "disclosed",
  reason: "disclosed as `x_gap` by the agent",
  ...extra,
});

describe("evaluateLaneGate", () => {
  test("a dead read fails", () => {
    expect(evaluateLaneGate(collectLaneCensus([W, dead]), []).map((v) => v.kind)).toEqual([
      "unmatched",
    ]);
  });
  test("an exempted dead read passes", () => {
    expect(evaluateLaneGate(collectLaneCensus([W, dead]), [ex("ghost")])).toEqual([]);
  });
  test("an annotated read passes", () => {
    const c = collectLaneCensus([
      W,
      R('// lane-census: scope=incident\nfunction f(meta: R) { return meta["status"]; }'),
    ]);
    expect(evaluateLaneGate(c, [])).toEqual([]);
  });
  test("an unannotated unscoped read fails", () => {
    const c = collectLaneCensus([W, R('function f(meta: R) { return meta["status"]; }')]);
    expect(evaluateLaneGate(c, []).map((v) => v.kind)).toEqual(["unscoped"]);
  });
  test("an unscoped read of a key nobody emits yields exactly one violation", () => {
    const c = collectLaneCensus([W, R('function f(meta: R) { return meta["nobody"]; }')]);
    expect(evaluateLaneGate(c, []).map((v) => v.kind)).toEqual(["unscoped"]);
  });
  test("an annotation error fails", () => {
    const c = collectLaneCensus([
      W,
      R('// lane-census: scope=nosuch\nfunction f(meta: R) { return meta["status"]; }'),
    ]);
    expect(evaluateLaneGate(c, []).some((v) => v.kind === "annotation")).toBe(true);
  });
  test("a stale exemption fails (Review Focus 3)", () => {
    expect(evaluateLaneGate(collectLaneCensus([W]), [ex("ghost")]).map((v) => v.kind)).toEqual([
      "stale-exemption",
    ]);
  });
  test("an exemption with an empty reason is invalid", () => {
    expect(
      evaluateLaneGate(collectLaneCensus([W, dead]), [ex("ghost", { reason: " " })]).some(
        (v) => v.kind === "invalid-exemption",
      ),
    ).toBe(true);
  });
  test("a duplicate (file, key) exemption is invalid, not reported as stale", () => {
    const v = evaluateLaneGate(collectLaneCensus([W, dead]), [ex("ghost"), ex("ghost")]);
    expect(v.map((x) => x.kind)).toEqual(["invalid-exemption"]);
  });
  test("a contract partial fails unless exempted", () => {
    const W2 = {
      relPath: "packages/gateway/src/connectors/og.ts",
      contents: 'ctx.upsertItem({ service: "opsgenie", type: "incident", metadata: {} });',
    };
    const W1 = {
      relPath: W.relPath,
      contents: 'ctx.upsertItem({ service: "pagerduty", type: "incident", metadata: { sev: 1 } });',
    };
    const read = R(
      "db.query(`SELECT 1 FROM item WHERE type = 'incident' AND json_extract(metadata, '$.sev') = 1`);",
    );
    expect(evaluateLaneGate(collectLaneCensus([W1, W2, read]), []).map((v) => v.kind)).toEqual([
      "partial",
    ]);
    expect(evaluateLaneGate(collectLaneCensus([W1, W2, read]), [ex("sev")])).toEqual([]);
  });
});

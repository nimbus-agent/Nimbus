import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asPushedBriefGet,
  asPushedBriefList,
  parseBriefPushed,
} from "../../src/hooks/useOncallBriefs";
import type {
  JsonRpcNotification,
  PushedBriefDetail,
  PushedBriefSummary,
} from "../../src/ipc/types";

const fixture: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "fixtures", "oncall-pushed.json"), "utf8"),
);
const part = (k: string): unknown => (fixture as Record<string, unknown>)[k];

describe("parseBriefPushed", () => {
  it("matches oncall.briefPushed and carries its id", () => {
    expect(
      parseBriefPushed({
        method: "gateway.event",
        params: {
          kind: "oncall.briefPushed",
          ts: 1,
          payload: { incidentId: "pagerduty:A", status: "ok" },
        },
      }),
    ).toEqual({ incidentId: "pagerduty:A" });
  });
  it("a matching kind with an unusable payload still matches, with a null id", () => {
    expect(
      parseBriefPushed({
        method: "gateway.event",
        params: { kind: "oncall.briefPushed", payload: 5 },
      }),
    ).toEqual({
      incidentId: null,
    });
  });
  it("ignores every other notification, including malformed ones", () => {
    for (const n of [
      { method: "gateway.event", params: { kind: "sync.completed", payload: {} } },
      { method: "connector.healthChanged", params: { kind: "oncall.briefPushed" } },
      { method: "gateway.event", params: null },
      { method: "gateway.event", params: {} },
      { method: "gateway.event", params: "oncall.briefPushed" },
    ]) {
      expect(parseBriefPushed(n)).toBeNull();
    }
  });
});

describe("asPushedBriefList / asPushedBriefGet", () => {
  it("accept the gateway-validated fixture", () => {
    expect(asPushedBriefList(part("list"))?.briefs.length).toBe(2);
    expect(asPushedBriefGet(part("getOk"))?.brief?.briefMarkdown).toEqual(expect.any(String));
    expect(asPushedBriefGet(part("getMissing"))).toEqual({ brief: null });
  });
  it("reject what is not that shape", () => {
    for (const v of [null, undefined, 3, {}, { enabled: true }, { enabled: true, briefs: "x" }]) {
      expect(asPushedBriefList(v)).toBeNull();
    }
    for (const v of [null, undefined, {}, { brief: 3 }])
      expect(asPushedBriefGet(v)).toBeUndefined();
  });
});

describe("the gateway-validated fixture binds the UI's field names", () => {
  // `satisfies` makes a renamed or added field in the UI type fail typecheck here; the sorted-key
  // comparison makes a renamed gateway field fail this test once the fixture is regenerated.
  const summaryKeys = [
    "createdAt",
    "incidentId",
    "retriedAt",
    "service",
    "status",
    "title",
  ] satisfies (keyof PushedBriefSummary)[];
  const detailKeys = [
    "briefMarkdown",
    "createdAt",
    "delivery",
    "failureCode",
    "incidentId",
    "retriedAt",
    "service",
    "status",
    "title",
  ] satisfies (keyof PushedBriefDetail)[];
  it("a list row has exactly the PushedBriefSummary keys", () => {
    const list = part("list") as { briefs: Record<string, unknown>[] };
    expect(Object.keys(list.briefs[0] ?? {}).sort()).toEqual(summaryKeys);
  });
  it("a detail has exactly the PushedBriefDetail keys", () => {
    const ok = part("getOk") as { brief: Record<string, unknown> };
    expect(Object.keys(ok.brief).sort()).toEqual(detailKeys);
  });
});

describe("the captured gateway event", () => {
  it("is recognised by parseBriefPushed and names the fired incident", () => {
    expect(parseBriefPushed(part("event") as JsonRpcNotification)).toEqual({
      incidentId: "pagerduty:PDEMO412",
    });
  });
});

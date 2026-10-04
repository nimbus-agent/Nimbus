import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asPushedBriefGet,
  asPushedBriefList,
  parseBriefPushed,
} from "../../src/hooks/useOncallBriefs";

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

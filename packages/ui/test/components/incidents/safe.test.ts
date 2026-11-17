import { describe, expect, it } from "vitest";
import {
  asIncidentGet,
  asIncidentList,
  asIncidentTimeline,
} from "../../../src/components/incidents/guards";
import { safeText } from "../../../src/components/incidents/safe";

const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const BEL = String.fromCharCode(7);

describe("safeText", () => {
  it("shows bidi, zero-width and control characters as \\u{...} instead of rendering them", () => {
    expect(safeText(["a", RLO, "b", ZWSP, "c", BEL, "d"].join(""))).toBe(
      String.raw`a\u{202E}b\u{200B}c\u{0007}d`,
    );
  });
  it("truncates and tolerates a non-string", () => {
    expect(safeText("x".repeat(20), 5)).toBe("xxxxx...");
    expect(safeText(undefined)).toBe("");
    expect(safeText(42)).toBe("");
  });
});

describe("guards", () => {
  it("accept the gateway shapes and reject others", () => {
    expect(asIncidentList({ status: "ok", records: [], sources: [] })).not.toBeNull();
    expect(asIncidentList({ status: "ok" })).toBeNull();
    expect(asIncidentList(null)).toBeNull();
    expect(asIncidentGet({ record: null, reason: "no_item" })).not.toBeNull();
    expect(asIncidentGet({ record: { summary: {}, markdown: "x", versions: [] } })).not.toBeNull();
    expect(asIncidentGet({ record: { summary: {}, markdown: "x" } })).toBeNull();
    expect(asIncidentGet({ record: { summary: {} } })).toBeNull();
    expect(asIncidentGet([])).toBeNull();
    expect(asIncidentTimeline({ recordId: "r", events: [], notes: [] })).not.toBeNull();
    expect(asIncidentTimeline({ recordId: "r", events: [] })).toBeNull();
    expect(asIncidentTimeline({ recordId: "r" })).toBeNull();
  });
});

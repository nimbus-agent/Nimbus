import { describe, expect, it } from "vitest";
import {
  csvEscape,
  extractActor,
  rowsToCsv,
  splitActionType,
  toDisplayRow,
} from "../../../../src/pages/settings/audit/audit-row-utils";

const baseRow = {
  id: 1,
  actionType: "github.sync",
  hitlStatus: "approved" as const,
  actionJson: '{"actor":"alice"}',
  timestamp: 1745126400000, // 2025-04-20T08:00:00.000Z
  rowHash: "abc",
  prevHash: "0",
};

describe("splitActionType", () => {
  it("splits on the first dot", () => {
    expect(splitActionType("github.sync")).toEqual({ service: "github", action: "sync" });
  });

  it("returns the full string for both halves when there is no dot", () => {
    expect(splitActionType("startup")).toEqual({ service: "startup", action: "startup" });
  });

  it("preserves dotted suffixes", () => {
    expect(splitActionType("data.export.completed")).toEqual({
      service: "data",
      action: "export.completed",
    });
  });
});

describe("extractActor", () => {
  it("returns an empty string for empty/{} payloads", () => {
    expect(extractActor("")).toBe("");
    expect(extractActor("{}")).toBe("");
  });

  it("returns the `actor` field when present and a string", () => {
    expect(extractActor('{"actor":"alice"}')).toBe("alice");
  });

  it("returns an empty string when JSON parse fails", () => {
    expect(extractActor("not json")).toBe("");
  });

  it("returns an empty string when actor is non-string", () => {
    expect(extractActor('{"actor":42}')).toBe("");
  });
});

describe("toDisplayRow", () => {
  it("materialises every field including ISO timestamp", () => {
    const d = toDisplayRow(baseRow);
    expect(d).toEqual({
      id: 1,
      tsIso: new Date(baseRow.timestamp).toISOString(), // TZ-agnostic equality
      service: "github",
      action: "sync",
      outcome: "approved",
      actor: "alice",
      rowHash: "abc",
    });
    expect(d.tsIso).toBe(new Date(baseRow.timestamp).toISOString());
  });
});

describe("csvEscape", () => {
  it("returns empty for empty", () => {
    expect(csvEscape("")).toBe("");
  });

  it("does not quote plain text", () => {
    expect(csvEscape("hello")).toBe("hello");
  });

  it("quotes when comma present", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  it("quotes and doubles interior quote", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes on CR/LF", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
});

describe("rowsToCsv", () => {
  it("emits header even for empty input", () => {
    expect(rowsToCsv([])).toBe("timestamp,service,actor,action,outcome,rowHash");
  });

  it("emits header + one row for one input", () => {
    const csv = rowsToCsv([baseRow]);
    const [header, line] = csv.split("\n");
    expect(header).toBe("timestamp,service,actor,action,outcome,rowHash");
    expect(line).toBe(
      `${new Date(baseRow.timestamp).toISOString()},github,alice,sync,approved,abc`,
    );
  });

  it("escapes commas inside fields", () => {
    const csv = rowsToCsv([{ ...baseRow, actionJson: '{"actor":"a,b"}' }]);
    const [, line] = csv.split("\n");
    expect(line.split(",").length).toBeGreaterThan(6);
    expect(line).toContain('"a,b"');
  });
});

import { describe, expect, test } from "bun:test";

import { buildRecord } from "../__fixtures__/record-builder.ts";
import type { IncidentRecordV1 } from "../incident-record-types.ts";
import { capRecordSize, gap, oneLine } from "./caps.ts";

function fat(n: number): IncidentRecordV1 {
  const base = buildRecord();
  const msg = (i: number) => ({
    id: `slack:${String(i)}`,
    service: "slack",
    title: "t".repeat(200),
    url: null,
    atMs: i,
    rule: "chat_phrase:x",
  });
  const hist = (i: number) => ({
    key: "status",
    from: "a".repeat(200),
    to: "b".repeat(200),
    observedAtMs: i,
    sourceAtMs: null,
  });
  return {
    ...base,
    chat: { ...base.chat, total: n, messages: Array.from({ length: n }, (_, i) => msg(i)) },
    history: {
      startsMs: 1,
      total: n,
      truncated: 0,
      rows: Array.from({ length: n }, (_, i) => hist(i)),
    },
  };
}

describe("oneLine", () => {
  test("removes format characters, collapses controls and caps by code points", () => {
    expect(oneLine("a\u{202E}b\u{200B}c\nd\te")).toBe("abc d e");
    const long = oneLine("😀".repeat(300));
    expect(Array.from(long)).toHaveLength(200);
    expect(long.endsWith("…")).toBe(true);
    expect(oneLine("  x  ")).toBe("x");
  });
});

describe("capRecordSize", () => {
  test("a record that fits is returned as is", () => {
    const r = buildRecord();
    expect(capRecordSize(r)).toEqual({ record: r, cuts: [] });
  });

  test("cuts in the fixed order chat, concurrent, prior, history, data, and says what it cut", () => {
    const r = fat(400);
    const out = capRecordSize(r, 30_000);
    expect(out.cuts.length).toBeGreaterThan(0);
    expect(out.cuts[0]?.lane).toBe("chat");
    expect(new TextEncoder().encode(JSON.stringify(out.record)).length).toBeLessThanOrEqual(30_000);
    // chat is cut before history is touched
    const lanes = out.cuts.map((c) => c.lane);
    expect(lanes.indexOf("chat")).toBeLessThan(
      lanes.includes("history") ? lanes.indexOf("history") : 99,
    );
    expect(out.record.chat.total).toBe(400); // the true total is kept
  });

  test("history cuts keep the truncated count honest", () => {
    const r = fat(300);
    const out = capRecordSize(r, 8_000);
    expect(out.record.history.truncated).toBe(
      out.record.history.total - out.record.history.rows.length,
    );
    expect(out.cuts.some((c) => c.lane === "history")).toBe(true);
  });
});

describe("gap", () => {
  test("omits an absent remediation", () => {
    expect(gap("missing_connector", "d")).toEqual({ category: "missing_connector", detail: "d" });
    expect(gap("missing_connector", "d", "r").remediation).toBe("r");
  });
});

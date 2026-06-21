import { describe, expect, test } from "bun:test";
import { buildEgressEntry, redactEgressSummary, summarizeDestination } from "./egress-record.ts";

describe("summarizeDestination", () => {
  test("derives the service prefix from a dotted action type", () => {
    expect(summarizeDestination("email.send")).toBe("email");
    expect(summarizeDestination("repo.commit.push")).toBe("repo");
  });
  test("returns the whole type when it has no dot", () => {
    expect(summarizeDestination("ping")).toBe("ping");
  });
});

describe("redactEgressSummary", () => {
  test("strips a ghp_ token and caps at 256 bytes", () => {
    const out = redactEgressSummary({ note: `token ghp_${"a".repeat(40)} done` });
    expect(out).not.toContain("ghp_");
    expect(out).toContain("[REDACTED]");
    expect(out.length).toBeLessThanOrEqual(256 + 16); // +slack for the truncation marker
  });
  test("strips a Bearer header and an sk- key", () => {
    const out = redactEgressSummary({ h: `Bearer ${"z".repeat(30)}`, k: `sk-${"y".repeat(30)}` });
    expect(out).not.toContain("zzzz");
    expect(out).not.toContain("sk-yyyy");
  });
  test("truncates an over-long payload to <= 256 bytes of body", () => {
    const out = redactEgressSummary({ big: "x".repeat(5000) });
    expect(out).toContain("…[truncated]");
    expect(out.length).toBeLessThanOrEqual(256 + "…[truncated]".length);
  });
});

describe("buildEgressEntry", () => {
  test("maps a planned action into an authorized ledger entry", () => {
    const e = buildEgressEntry({
      action: { type: "email.send", payload: { to: "a@b.c" } },
      hitlStatus: "approved",
      resultStatus: "authorized",
      sessionId: "sess-1",
      now: 1700,
    });
    expect(e.timestamp).toBe(1700);
    expect(e.sourceType).toBe("task");
    expect(e.sourceId).toBe("sess-1");
    expect(e.destination).toBe("email");
    expect(e.method).toBe("email.send");
    expect(e.hitlStatus).toBe("approved");
    expect(e.resultStatus).toBe("authorized");
    expect(e.payloadSummary).toContain("a@b.c");
  });
  test("uses sourceType 'task' and a null sourceId when no session is present", () => {
    const e = buildEgressEntry({
      action: { type: "repo.commit.push" },
      hitlStatus: "not_required",
      resultStatus: "authorized",
      sessionId: undefined,
      now: 5,
    });
    expect(e.sourceId).toBeNull();
    expect(e.payloadSummary).toBe("{}");
  });
  test("a rejected gate yields a blocked entry", () => {
    const e = buildEgressEntry({
      action: { type: "data.delete", payload: { id: 1 } },
      hitlStatus: "rejected",
      resultStatus: "blocked",
      sessionId: "s",
      now: 9,
    });
    expect(e.resultStatus).toBe("blocked");
    expect(e.hitlStatus).toBe("rejected");
  });
});

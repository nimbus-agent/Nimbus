import { describe, expect, test } from "bun:test";
import {
  AGENT_SOURCE_PREFIX,
  buildEgressEntry,
  redactEgressSummary,
  summarizeDestination,
} from "./egress-record.ts";

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

  test("a standing-approved gate yields an authorized entry with that status (SA1)", () => {
    const e = buildEgressEntry({
      action: { type: "gmail.thread.archive", payload: {} },
      hitlStatus: "standing_approved",
      resultStatus: "authorized",
      sessionId: undefined,
      now: 3,
    });
    expect(e.hitlStatus).toBe("standing_approved");
    expect(e.resultStatus).toBe("authorized");
  });
});

describe("buildEgressEntry - an outside agent's action (AD4)", () => {
  const ID = `cap_${"ab12".repeat(8)}`;
  const base = {
    action: { type: "slack.message.post", payload: { text: "hi" } },
    hitlStatus: "approved" as const,
    resultStatus: "authorized" as const,
    sessionId: "sess-1",
    now: 5,
  };

  test("source_id is agent:<captureId> (the session id is not used) and the summary starts with the label", () => {
    const e = buildEgressEntry({ ...base, agent: { captureId: ID, label: "claude-desktop" } });
    expect(e.sourceType).toBe("task");
    expect(e.sourceId).toBe(`${AGENT_SOURCE_PREFIX}${ID}`);
    expect(e.payloadSummary).toBe('{"agent":{"label":"claude-desktop"},"text":"hi"}');
  });

  test("a null label is recorded as null", () => {
    const e = buildEgressEntry({ ...base, agent: { captureId: ID, label: null } });
    expect(e.payloadSummary.startsWith('{"agent":{"label":null},')).toBe(true);
  });

  test("the label is cut to 48 units and never ends on half a surrogate pair", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const long = `${"x".repeat(47)}${emoji}tail`;
    const e = buildEgressEntry({ ...base, agent: { captureId: ID, label: long } });
    expect(e.payloadSummary.startsWith(`{"agent":{"label":"${"x".repeat(47)}"}`)).toBe(true);
    const exact = buildEgressEntry({ ...base, agent: { captureId: ID, label: "y".repeat(48) } });
    expect(exact.payloadSummary.startsWith(`{"agent":{"label":"${"y".repeat(48)}"}`)).toBe(true);
  });

  test("a label with a pipe, quotes, backslash, control and astral characters changes no hashed field", () => {
    const nasty = `a|b"cd${String.fromCodePoint(0x1b)}${String.fromCodePoint(0x1f600)}|agent:cap_x`;
    const a = buildEgressEntry({ ...base, agent: { captureId: ID, label: nasty } });
    const b = buildEgressEntry({ ...base, agent: { captureId: ID, label: "plain" } });
    const hashed = (e: typeof a): unknown[] => [
      e.timestamp,
      e.sourceType,
      e.sourceId,
      e.destination,
      e.method,
      e.hitlStatus,
      e.resultStatus,
    ];
    expect(hashed(a)).toEqual(hashed(b));
  });

  test("a payload cannot overwrite the agent or standingFire head", () => {
    const e = buildEgressEntry({
      ...base,
      action: { type: "slack.message.post", payload: { agent: { label: "owner" }, text: "hi" } },
      agent: { captureId: ID, label: "real" },
    });
    expect(e.payloadSummary).toBe('{"agent":{"label":"real"},"text":"hi"}');
  });

  test("the summary stays within the 256-unit cap", () => {
    const e = buildEgressEntry({
      ...base,
      action: { type: "slack.message.post", payload: { text: "z".repeat(900) } },
      agent: { captureId: ID, label: "L".repeat(100) },
    });
    expect(e.payloadSummary.length).toBeLessThanOrEqual(256 + "…[truncated]".length);
  });

  for (const bad of ["cap_ad1", `cap_${"A".repeat(32)}`, `${ID}|x`, "", "agent:cap_x"]) {
    test(`a malformed capture id '${bad}' throws`, () => {
      expect(() => buildEgressEntry({ ...base, agent: { captureId: bad, label: "x" } })).toThrow();
    });
  }

  test("without an agent the entry is what it always was", () => {
    const e = buildEgressEntry(base);
    expect(e.sourceId).toBe("sess-1");
    expect(e.payloadSummary).toBe('{"text":"hi"}');
  });
});

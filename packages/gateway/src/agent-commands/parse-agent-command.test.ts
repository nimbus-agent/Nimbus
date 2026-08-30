import { describe, expect, test } from "bun:test";
import { parseAgentCommand } from "./parse-agent-command.ts";

const PERMITTED = new Set(["why", "expert", "decisions", "ghost"]);

describe("parseAgentCommand", () => {
  test("returns null for a non-agent message — the read fallthrough must still work", () => {
    expect(parseAgentCommand("why is checkout slow?", PERMITTED)).toBeNull();
    expect(parseAgentCommand("run deployment.rollback service=api", PERMITTED)).toBeNull();
  });

  test("parses agent + k=v and coerces per the declared kind", () => {
    expect(parseAgentCommand("agent why ref=src/auth.ts line=42", PERMITTED)).toEqual({
      ok: true,
      agent: "why",
      params: { ref: "src/auth.ts", line: 42 },
    });
  });

  test("splits a stringArray on commas", () => {
    expect(parseAgentCommand("agent ghost file=a.ts namespaces=team-a,team-b", PERMITTED)).toEqual({
      ok: true,
      agent: "ghost",
      params: { file: "a.ts", namespaces: ["team-a", "team-b"] },
    });
  });

  test("REJECTS a non-finite number — minConfidence would otherwise pass its validator", () => {
    const r = parseAgentCommand("agent decisions minConfidence=high", PERMITTED);
    expect(r).toEqual({ ok: false, detail: expect.stringContaining("minConfidence") });
  });

  test("rejects Infinity too, not just NaN", () => {
    expect(parseAgentCommand("agent decisions minConfidence=Infinity", PERMITTED)).toMatchObject({
      ok: false,
    });
  });

  test("refuses an agent outside the permitted set", () => {
    expect(parseAgentCommand("agent premortem epic=X", PERMITTED)).toEqual({
      ok: false,
      detail: expect.stringContaining("premortem"),
    });
  });

  test("refuses an undeclared param rather than passing it through", () => {
    expect(parseAgentCommand("agent why ref=a.ts bogus=1", PERMITTED)).toMatchObject({ ok: false });
  });

  test("refuses a bare `agent` with no name", () => {
    expect(parseAgentCommand("agent", PERMITTED)).toMatchObject({ ok: false });
  });

  test("strips chat decoration before parsing", () => {
    expect(parseAgentCommand("@nimbus agent why ref=“a.ts”", PERMITTED)).toEqual({
      ok: true,
      agent: "why",
      params: { ref: "a.ts" },
    });
  });
});

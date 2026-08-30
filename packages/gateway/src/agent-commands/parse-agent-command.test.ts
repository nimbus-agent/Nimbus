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
    expect(r).toEqual({
      ok: false,
      reason: "bad_agent_params",
      detail: expect.stringContaining("minConfidence"),
    });
  });

  test("rejects Infinity too, not just NaN", () => {
    expect(parseAgentCommand("agent decisions minConfidence=Infinity", PERMITTED)).toMatchObject({
      ok: false,
    });
  });

  test("refuses an agent outside the permitted set", () => {
    expect(parseAgentCommand("agent premortem epic=X", PERMITTED)).toEqual({
      ok: false,
      reason: "unknown_agent",
      detail: expect.stringContaining("premortem"),
    });
  });

  test("structurally pins reason: unknown_agent for an unpermitted agent name", () => {
    // Asserts the field directly rather than through the `Unknown or unavailable agent ` prose —
    // `command-parser.ts` used to regex-match that string; `reason` is what it reads now.
    const r = parseAgentCommand("agent nope", PERMITTED);
    expect(r?.ok).toBe(false);
    if (r !== null && !r.ok) expect(r.reason).toBe("unknown_agent");
  });

  test("structurally pins reason: bad_agent_params for a malformed-params refusal", () => {
    const r = parseAgentCommand("agent why not-kv", PERMITTED);
    expect(r?.ok).toBe(false);
    if (r !== null && !r.ok) expect(r.reason).toBe("bad_agent_params");
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

  test("coerces boolean 'true' and 'false' to real booleans, not truthy strings", () => {
    expect(parseAgentCommand("agent decisions explain=true", PERMITTED)).toEqual({
      ok: true,
      agent: "decisions",
      params: { explain: true },
    });
    expect(parseAgentCommand("agent decisions explain=false", PERMITTED)).toEqual({
      ok: true,
      agent: "decisions",
      params: { explain: false },
    });
  });

  test("rejects a boolean value that is neither 'true' nor 'false'", () => {
    // `requireDecisionsParams` reads `p.explain === true` with no type check, so anything that
    // slips past coercion as a non-boolean would silently become `false` rather than erroring —
    // this is the one place a typo like 'yes' is reported to the user at all.
    expect(parseAgentCommand("agent decisions explain=yes", PERMITTED)).toEqual({
      ok: false,
      reason: "bad_agent_params",
      detail: expect.stringContaining("explain"),
    });
  });

  test("drops empty segments from a stringArray split — a double comma or trailing comma", () => {
    expect(
      parseAgentCommand("agent ghost file=a.ts namespaces=team-a,,team-b,", PERMITTED),
    ).toEqual({
      ok: true,
      agent: "ghost",
      params: { file: "a.ts", namespaces: ["team-a", "team-b"] },
    });
  });

  test("refuses a bare token that isn't k=v shaped", () => {
    expect(parseAgentCommand("agent why ref=a.ts justtext", PERMITTED)).toEqual({
      ok: false,
      reason: "bad_agent_params",
      detail: expect.stringContaining("Bad argument"),
    });
  });

  test("null (not an agent command) is distinguishable from a refusal ({ ok: false })", () => {
    // The caller branches on this: `null` falls through to the free-text read path, a refusal
    // does not. Collapsing the two would turn an ordinary question into a dead end.
    const notACommand = parseAgentCommand("why is checkout slow?", PERMITTED);
    const refused = parseAgentCommand("agent premortem epic=X", PERMITTED);
    expect(notACommand).toBeNull();
    expect(refused).not.toBeNull();
    expect(refused).toMatchObject({ ok: false });
  });
});

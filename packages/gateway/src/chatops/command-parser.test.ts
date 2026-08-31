import { describe, expect, test } from "bun:test";
import { normalizeChatText, parseCommand } from "./command-parser.ts";

const KNOWN = new Set(["deployment.rollback", "deployment.apply"]);
const PERMITTED_AGENTS = new Set(["why"]);

describe("normalizeChatText", () => {
  test("strips leading mention, unwraps slack links, normalizes smart quotes + backticks", () => {
    expect(normalizeChatText("<@U123> run deployment.rollback service=`pay`")).toBe(
      "run deployment.rollback service=pay",
    );
    expect(normalizeChatText("@nimbus who owns <http://x.com|x.com>?")).toBe("who owns x.com?");
    expect(normalizeChatText("run x svc=“pay”")).toBe('run x svc="pay"');
  });
});

describe("parseCommand", () => {
  test("free NL -> read", () => {
    expect(
      parseCommand("<@U1> who's on call for payment-service?", KNOWN, PERMITTED_AGENTS),
    ).toEqual({
      kind: "read",
      query: "who's on call for payment-service?",
    });
  });

  test("structured write -> known action with args + resource", () => {
    const c = parseCommand(
      "@nimbus run deployment.rollback service=payment-service version=v1.4",
      KNOWN,
      PERMITTED_AGENTS,
    );
    expect(c).toEqual({
      kind: "write",
      actionType: "deployment.rollback",
      args: { service: "payment-service", version: "v1.4" },
      resource: "payment-service",
    });
  });

  test("unknown action -> refused (never guessed)", () => {
    const c = parseCommand("run deployment.nuke service=x", KNOWN, PERMITTED_AGENTS);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("unknown_action");
  });

  test("run with no action token -> ambiguous refusal", () => {
    expect(parseCommand("run", KNOWN, PERMITTED_AGENTS).kind).toBe("refused");
  });

  test("write missing a resource arg -> ambiguous refusal", () => {
    const c = parseCommand("run deployment.rollback version=v1.4", KNOWN, PERMITTED_AGENTS);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("ambiguous_command");
  });

  test("an agent command parses to the agent kind, ahead of the read fallthrough", () => {
    expect(parseCommand("agent why ref=a.ts", KNOWN, PERMITTED_AGENTS)).toEqual({
      kind: "agent",
      agent: "why",
      params: { ref: "a.ts" },
    });
  });

  test("a plain question is still a read", () => {
    expect(parseCommand("why is checkout slow?", KNOWN, PERMITTED_AGENTS)).toEqual({
      kind: "read",
      query: "why is checkout slow?",
    });
  });

  test("`run` still wins — the write grammar is unchanged", () => {
    expect(parseCommand("run deployment.rollback service=api", KNOWN, PERMITTED_AGENTS).kind).toBe(
      "write",
    );
  });

  test("an unknown agent refuses with unknown_agent", () => {
    expect(parseCommand("agent nope", KNOWN, PERMITTED_AGENTS)).toMatchObject({
      kind: "refused",
      reason: "unknown_agent",
    });
  });

  test("a permitted agent with a bad k=v argument refuses with bad_agent_params, not unknown_agent", () => {
    expect(parseCommand("agent why not-kv", KNOWN, PERMITTED_AGENTS)).toMatchObject({
      kind: "refused",
      reason: "bad_agent_params",
    });
  });

  test("`agent` with no name at all refuses with bad_agent_params", () => {
    expect(parseCommand("agent", KNOWN, PERMITTED_AGENTS)).toMatchObject({
      kind: "refused",
      reason: "bad_agent_params",
    });
  });
});

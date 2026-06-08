import { describe, expect, test } from "bun:test";
import { normalizeChatText, parseCommand } from "./command-parser.ts";

const KNOWN = new Set(["deployment.rollback", "deployment.apply"]);

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
    expect(parseCommand("<@U1> who's on call for payment-service?", KNOWN)).toEqual({
      kind: "read",
      query: "who's on call for payment-service?",
    });
  });

  test("structured write -> known action with args + resource", () => {
    const c = parseCommand(
      "@nimbus run deployment.rollback service=payment-service version=v1.4",
      KNOWN,
    );
    expect(c).toEqual({
      kind: "write",
      actionType: "deployment.rollback",
      args: { service: "payment-service", version: "v1.4" },
      resource: "payment-service",
    });
  });

  test("unknown action -> refused (never guessed)", () => {
    const c = parseCommand("run deployment.nuke service=x", KNOWN);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("unknown_action");
  });

  test("run with no action token -> ambiguous refusal", () => {
    expect(parseCommand("run", KNOWN).kind).toBe("refused");
  });

  test("write missing a resource arg -> ambiguous refusal", () => {
    const c = parseCommand("run deployment.rollback version=v1.4", KNOWN);
    expect(c.kind).toBe("refused");
    if (c.kind === "refused") expect(c.reason).toBe("ambiguous_command");
  });
});

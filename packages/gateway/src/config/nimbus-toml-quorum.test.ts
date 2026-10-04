import { describe, expect, it } from "bun:test";
import { parseQuorumConfig } from "./nimbus-toml.ts";

describe("[hitl.quorum] config", () => {
  it("parses action-type -> {approvers, windowSeconds}", () => {
    const raw = [
      '[hitl.quorum."iac.terraform.destroy"]',
      "approvers = 2",
      "window_seconds = 300",
    ].join("\n");
    const cfg = parseQuorumConfig(raw);
    expect(cfg.get("iac.terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 300 });
  });

  it("defaults to empty when absent (quorum off)", () => {
    expect(parseQuorumConfig("").size).toBe(0);
  });

  it.each([
    ["non-numeric approvers", "approvers = bad", "window_seconds = 300"],
    ["approvers < 1", "approvers = 0", "window_seconds = 300"],
    ["window_seconds <= 0", "approvers = 2", "window_seconds = 0"],
  ])("ignores malformed rows — %s", (_label, approvers, windowSeconds) => {
    const raw = ['[hitl.quorum."x.y"]', approvers, windowSeconds].join("\n");
    const cfg = parseQuorumConfig(raw);
    expect(cfg.has("x.y")).toBe(false);
  });

  it("parses multiple action-type sub-tables", () => {
    const raw = [
      '[hitl.quorum."iac.terraform.destroy"]',
      "approvers = 2",
      "window_seconds = 300",
      "",
      '[hitl.quorum."db.schema.drop"]',
      "approvers = 3",
      "window_seconds = 600",
    ].join("\n");
    const cfg = parseQuorumConfig(raw);
    expect(cfg.size).toBe(2);
    expect(cfg.get("iac.terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 300 });
    expect(cfg.get("db.schema.drop")).toEqual({ approvers: 3, windowSeconds: 600 });
  });

  it("skips sections that are not [hitl.quorum.*]", () => {
    const raw = ["[other.section]", "approvers = 2", "window_seconds = 300"].join("\n");
    expect(parseQuorumConfig(raw).size).toBe(0);
  });

  it("skips a window_seconds line with a genuinely unterminated quoted value, instead of accepting its leading numeric prefix", () => {
    // Without the guard, the raw value "300 \"typo is stored unparsed, and
    // Number.parseInt tolerates trailing garbage after a valid numeric
    // prefix — so window_seconds silently becomes 300 from a malformed
    // line. The guard drops the whole line, so the rule never registers.
    const raw = ['[hitl.quorum."x.y"]', "approvers = 2", 'window_seconds = 300 "typo'].join("\n");
    expect(parseQuorumConfig(raw).has("x.y")).toBe(false);
  });
});

describe("[hitl.quorum] — a malformed header never weakens the PREVIOUS rule (I21)", () => {
  const strict = ['[hitl.quorum."slack.message.post"]', "approvers = 3", "window_seconds = 600"];
  const weak = ["approvers = 1", "window_seconds = 60"];

  // Each of these headers used to leave the scanner on the previous, VALID table, so the
  // `approvers = 1` written under it silently replaced `slack.message.post`'s 3 approvers: a typo
  // in one rule turned a 3-of-N quorum on another into a 1-of-N one.
  it.each([
    ["missing its closing bracket", '[hitl.quorum."jira.issue.create"'],
    ["whose quote never closes", '[hitl.quorum."jira.issue.create]'],
    ["with text after its closing bracket", '[hitl.quorum."jira.issue.create"] approvers = 1'],
  ])("a header %s ends the previous rule and opens none", (_label, header) => {
    const cfg = parseQuorumConfig([...strict, header, ...weak].join("\n"));
    expect(cfg.get("slack.message.post")).toEqual({ approvers: 3, windowSeconds: 600 });
    expect([...cfg.keys()]).toEqual(["slack.message.post"]);
  });

  it("a bracketed header with text between its closing quote and bracket opens no rule", () => {
    // Recognised as a header but not as a quorum one, so the previous rule ends here too.
    const cfg = parseQuorumConfig(
      [...strict, '[hitl.quorum."jira.issue.create"x]', ...weak].join("\n"),
    );
    expect(cfg.get("slack.message.post")).toEqual({ approvers: 3, windowSeconds: 600 });
    expect([...cfg.keys()]).toEqual(["slack.message.post"]);
  });

  it("a VALID header after a malformed one still opens its own rule", () => {
    const cfg = parseQuorumConfig(
      [
        ...strict,
        '[hitl.quorum."jira.issue.create"',
        ...weak,
        '[hitl.quorum."db.schema.drop"]',
        "approvers = 2",
        "window_seconds = 300",
      ].join("\n"),
    );
    expect(cfg.get("slack.message.post")).toEqual({ approvers: 3, windowSeconds: 600 });
    expect(cfg.get("db.schema.drop")).toEqual({ approvers: 2, windowSeconds: 300 });
    expect(cfg.has("jira.issue.create")).toBe(false);
  });
});

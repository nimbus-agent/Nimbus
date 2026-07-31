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

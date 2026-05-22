import { describe, expect, test } from "bun:test";
import { formatScanPretty, parseSecurityArgs } from "./security.ts";

const RESULT_FIXTURE = {
  scanned_at_ms: 1_747_000_000_000,
  items_scanned: 12,
  items_skipped_depth: 3,
  findings_count: 2,
  findings: [
    {
      item_id: "filesystem:src/config.ts",
      service: "filesystem",
      type: "code_symbol",
      title: "config.ts",
      pattern_name: "aws_access_key",
      pattern_category: "api_key" as const,
      match_redacted: "AKIA****MPLE",
      match_offset: 12,
      context_snippet: "k='[REDACTED]'",
      modified_at_ms: 1_746_000_000_000,
      url: null,
    },
    {
      item_id: "obsidian:Drafts/onboarding.md",
      service: "obsidian",
      type: "obsidian_note",
      title: "onboarding.md",
      pattern_name: "anthropic_api_key",
      pattern_category: "api_key" as const,
      match_redacted: "sk-a****1234",
      match_offset: 200,
      context_snippet: "API key: [REDACTED] used by",
      modified_at_ms: 1_745_000_000_000,
      url: null,
    },
  ],
  skipped_connectors: [{ service: "gmail", depth: "metadata_only" as const }],
};

describe("parseSecurityArgs", () => {
  test("scan with no flags", () => {
    const parsed = parseSecurityArgs(["scan"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(false);
  });

  test("scan --json", () => {
    const parsed = parseSecurityArgs(["scan", "--json"]);
    expect(parsed.subcommand).toBe("scan");
    expect(parsed.json).toBe(true);
  });

  test("help subcommand", () => {
    const parsed = parseSecurityArgs(["help"]);
    expect(parsed.subcommand).toBe("help");
  });

  test("unknown subcommand throws", () => {
    expect(() => parseSecurityArgs(["bogus"])).toThrow();
  });

  test("missing subcommand throws", () => {
    expect(() => parseSecurityArgs([])).toThrow();
  });
});

describe("formatScanPretty", () => {
  test("renders header + finding table + skipped connectors", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).toContain("Scanned 12 items");
    expect(out).toContain("Skipped 3 items");
    expect(out).toContain("gmail");
    expect(out).toContain("aws_access_key");
    expect(out).toContain("AKIA****MPLE");
    expect(out).toContain("anthropic_api_key");
    expect(out).toContain("filesystem:src/config.ts");
  });

  test("no findings, no skipped — prints clean message", () => {
    const out = formatScanPretty(
      {
        ...RESULT_FIXTURE,
        items_skipped_depth: 0,
        findings_count: 0,
        findings: [],
        skipped_connectors: [],
      },
      { tty: false, noColor: true },
    );
    expect(out).toContain("0 findings");
    expect(out).not.toContain("Skipped");
  });

  test("renders without ANSI when noColor is true", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: true, noColor: true });
    expect(out.includes("\x1b[")).toBe(false);
  });

  test("does NOT leak the full secret in pretty output", () => {
    const out = formatScanPretty(RESULT_FIXTURE, { tty: false, noColor: true });
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

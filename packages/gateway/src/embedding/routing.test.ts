import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_DIM_LOCAL,
  EMBEDDING_DIM_OPENAI,
  isProseHeavy,
  PROSE_HEAVY_TYPES,
  routingKey,
  SUPPORTED_EMBEDDING_DIMS,
} from "./routing.ts";

describe("embedding/routing", () => {
  test("dimension constants", () => {
    expect(EMBEDDING_DIM_LOCAL).toBe(384);
    expect(EMBEDDING_DIM_OPENAI).toBe(1536);
    expect(SUPPORTED_EMBEDDING_DIMS.has(384)).toBe(true);
    expect(SUPPORTED_EMBEDDING_DIMS.has(1536)).toBe(true);
    expect(SUPPORTED_EMBEDDING_DIMS.has(512)).toBe(false);
  });

  test("PROSE_HEAVY_TYPES exact membership (17 entries)", () => {
    const expected = new Set([
      "slack:message",
      "discord:message",
      "teams:message",
      "gmail:email",
      "outlook:email",
      "notion:page",
      "confluence:page",
      "obsidian:obsidian_note",
      "pagerduty:incident",
      "linear:issue",
      "jira:issue",
      "github:issue",
      "gitlab:issue",
      "bitbucket:issue",
      "snyk:vulnerability",
      "zoom:transcript",
      "imap:email",
    ]);
    expect(PROSE_HEAVY_TYPES.size).toBe(expected.size);
    for (const key of expected) {
      expect(PROSE_HEAVY_TYPES.has(key)).toBe(true);
    }
    for (const key of PROSE_HEAVY_TYPES) {
      expect(expected.has(key)).toBe(true);
    }
  });

  test("isProseHeavy returns true for snyk:vulnerability", () => {
    expect(isProseHeavy("snyk", "vulnerability")).toBe(true);
  });

  test("isProseHeavy returns true for zoom:transcript", () => {
    expect(isProseHeavy("zoom", "transcript")).toBe(true);
  });

  test("isProseHeavy returns true for imap:email", () => {
    expect(isProseHeavy("imap", "email")).toBe(true);
  });

  test("routingKey formats correctly", () => {
    expect(routingKey("slack", "message")).toBe("slack:message");
    expect(routingKey("a", "b")).toBe("a:b");
  });

  test("isProseHeavy returns true for prose-heavy pairs", () => {
    expect(isProseHeavy("slack", "message")).toBe(true);
    expect(isProseHeavy("obsidian", "obsidian_note")).toBe(true);
    expect(isProseHeavy("pagerduty", "incident")).toBe(true);
  });

  test("isProseHeavy returns false for non-prose pairs", () => {
    expect(isProseHeavy("github", "git_commit")).toBe(false);
    expect(isProseHeavy("aws", "lambda_function")).toBe(false);
    expect(isProseHeavy("slack", "channel")).toBe(false);
    expect(isProseHeavy("", "")).toBe(false);
  });
});

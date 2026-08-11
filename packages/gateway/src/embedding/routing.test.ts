import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_DIM_LOCAL,
  EMBEDDING_DIM_OPENAI,
  isProseHeavy,
  LOCAL_ONLY_PROSE_TYPES,
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

  test("PROSE_HEAVY_TYPES exact membership (22 entries)", () => {
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
      "fastmail:email",
      "protonmail:email",
      "apple:email",
      "nimbus:research_brief",
      "nimbus:glossary_term",
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

  test("isProseHeavy: apple:email is prose-heavy, apple:event is not", () => {
    expect(isProseHeavy("apple", "email")).toBe(true);
    expect(isProseHeavy("apple", "event")).toBe(false);
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

  test("mercury item types are not prose-heavy (structured finance rows stay on MiniLM)", () => {
    // A transaction is a counterparty + an amount + a short memo, not paragraph
    // prose. Routing it to OpenAI would bill the user per bank transaction.
    expect(isProseHeavy("mercury", "transaction")).toBe(false);
    expect(isProseHeavy("mercury", "account")).toBe(false);
  });

  test("google_meet:meeting is not prose-heavy even with participant names", () => {
    // Conference records are sparse timestamps + ids + a name list, not
    // paragraph prose. Participant detail does not change that; routing to
    // OpenAI would bill the user per meeting.
    expect(isProseHeavy("google_meet", "meeting")).toBe(false);
  });

  test("workday item types are not prose-heavy (384-dim default)", () => {
    for (const t of ["worker", "time_off", "job_posting", "report"]) {
      expect(isProseHeavy("workday", t)).toBe(false);
    }
  });
});

describe("routing — web clip", () => {
  // #1006. Both web-clipper store listings state that clipped content stays on
  // the user's machine. `isProseHeavy` false is the whole of what keeps that
  // true: the routing pipeline sends prose-heavy items to OpenAI whenever
  // `openai.api_key` is set, so a `true` here would put clip text on the wire
  // and contradict a public claim on two stores.
  test("nimbus:web_clip is NOT prose-heavy — clips never reach the remote embedder", () => {
    expect(isProseHeavy("nimbus", "web_clip")).toBe(false);
    expect(PROSE_HEAVY_TYPES.has("nimbus:web_clip")).toBe(false);
  });
  test("nimbus:web_clip is pinned local-only", () => {
    expect(LOCAL_ONLY_PROSE_TYPES.has("nimbus:web_clip")).toBe(true);
  });
  test("a non-prose nimbus type is not prose-heavy", () => {
    expect(isProseHeavy("nimbus", "other")).toBe(false);
  });
});

describe("routing — local-only prose types", () => {
  /**
   * Stated as what CANNOT hold rather than as an allow-list: membership in
   * `LOCAL_ONLY_PROSE_TYPES` is not itself enforcement — it only feeds the body
   * cap. What keeps a type off the remote embedder is its ABSENCE from
   * `PROSE_HEAVY_TYPES`, so a key present in both sets would read as "pinned
   * local" while routing remotely. That is the exact silent regression this
   * pins, and it is invisible to every other test in the file.
   */
  test("no type is in both PROSE_HEAVY_TYPES and LOCAL_ONLY_PROSE_TYPES", () => {
    const both = [...LOCAL_ONLY_PROSE_TYPES].filter((k) => PROSE_HEAVY_TYPES.has(k));
    expect(both).toEqual([]);
  });

  test("every local-only type routes to MiniLM-384", () => {
    for (const key of LOCAL_ONLY_PROSE_TYPES) {
      const [service, type] = key.split(":");
      expect(isProseHeavy(service as string, type as string)).toBe(false);
    }
  });
});

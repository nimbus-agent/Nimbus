import { describe, expect, test } from "bun:test";
import { looksLikeCredential as reexported } from "../connectors/connector-writes/commit-paths.ts";
import { CREDENTIAL_PATTERN_COUNT, looksLikeCredential } from "./credential-text.ts";
import { SECRET_PATTERNS } from "./secret-patterns.ts";

describe("credential-text", () => {
  test("flags a GitHub token and passes plain prose", () => {
    expect(looksLikeCredential(`token ghp_${"a".repeat(36)}`)).toBe(true);
    expect(looksLikeCredential("close the old stale pull requests")).toBe(false);
  });
  test("one compiled pattern per shared pattern", () => {
    expect(CREDENTIAL_PATTERN_COUNT).toBe(SECRET_PATTERNS.length);
  });
  test("commit-paths re-exports the same function", () => {
    expect(reexported).toBe(looksLikeCredential);
  });
});

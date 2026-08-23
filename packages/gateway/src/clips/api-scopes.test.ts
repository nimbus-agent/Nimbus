import { describe, expect, test } from "bun:test";
import { API_SCOPES, isApiScope, LEGACY_SCOPES } from "./api-scopes.ts";

describe("api-scopes", () => {
  test("the vocabulary is exactly the six scopes, in declaration order", () => {
    expect([...API_SCOPES]).toEqual(["clip", "briefs", "agents", "resolve", "fetch", "egress"]);
  });

  test("LEGACY_SCOPES grants exactly what a pre-scopes token could already do", () => {
    // The whole point of the migration: a token in the wild gains NOTHING.
    expect([...LEGACY_SCOPES]).toEqual(["clip", "briefs"]);
    expect(LEGACY_SCOPES).not.toContain("agents");
    expect(LEGACY_SCOPES).not.toContain("resolve");
    expect(LEGACY_SCOPES).not.toContain("fetch");
    // `egress` reads the record of everything this gateway sent on the owner's
    // behalf. A token minted before the scope existed must not silently acquire
    // it — the owner grants it deliberately with `nimbus clip scopes`.
    expect(LEGACY_SCOPES).not.toContain("egress");
  });

  test("isApiScope accepts known scopes and rejects everything else", () => {
    expect(isApiScope("agents")).toBe(true);
    expect(isApiScope("admin")).toBe(false);
    expect(isApiScope("")).toBe(false);
    expect(isApiScope(null)).toBe(false);
    expect(isApiScope(42)).toBe(false);
  });
});

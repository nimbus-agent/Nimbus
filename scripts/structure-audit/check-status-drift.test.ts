import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { auditStatusDrift } from "./check-status-drift.ts";

function makeRepo(layout: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "status-drift-audit-"));
  for (const [relPath, contents] of Object.entries(layout)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents, "utf8");
  }
  return root;
}

/** Minimal repo whose canonical numbers are I27 / V42 and whose surfaces agree. */
function inSync(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "packages/gateway/src/index/local-index.ts": "export const CURRENT_SCHEMA_VERSION = 42;\n",
    "packages/gateway/src/index/foo-v42-sql.ts": "// migration",
    "packages/gateway/src/security-invariants.test.ts": 'describe("I27", () => {});\n',
    "CLAUDE.md": "Status: invariants through I27; schema V42.\n",
    "GEMINI.md": "Status: invariants through I27; schema V42.\n",
    "docs/architecture.md": "Current invariants through I27; schema V42.\n",
    "docs/SECURITY-INVARIANTS.md":
      "**Current ceiling:** invariants I1–I27.\n\n## I27 — the share gate\n",
    ...overrides,
  };
}

describe("auditStatusDrift", () => {
  test("passes when every surface matches the canonical I27 / V42", () => {
    const result = auditStatusDrift(makeRepo(inSync()));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags a stale invariant ceiling in CLAUDE.md", () => {
    const result = auditStatusDrift(
      makeRepo(inSync({ "CLAUDE.md": "invariants through I26; schema V42.\n" })),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("CLAUDE.md") && e.includes("I26"))).toBe(true);
  });

  test("flags a stale schema version in docs/architecture.md", () => {
    const result = auditStatusDrift(
      makeRepo(inSync({ "docs/architecture.md": "invariants through I27; schema V40.\n" })),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("architecture.md") && e.includes("V40"))).toBe(
      true,
    );
  });

  test("flags CURRENT_SCHEMA_VERSION ahead of the highest migration file", () => {
    const result = auditStatusDrift(
      makeRepo(
        inSync({
          "packages/gateway/src/index/local-index.ts":
            "export const CURRENT_SCHEMA_VERSION = 43;\n",
          // surfaces say V43 so the surface check passes; only the cross-check fires
          "CLAUDE.md": "invariants through I27; schema V43.\n",
          "GEMINI.md": "invariants through I27; schema V43.\n",
          "docs/architecture.md": "invariants through I27; schema V43.\n",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("CURRENT_SCHEMA_VERSION"))).toBe(true);
  });

  test("flags a stale '## I<N>' heading max in SECURITY-INVARIANTS.md", () => {
    const result = auditStatusDrift(
      makeRepo(
        inSync({
          "docs/SECURITY-INVARIANTS.md":
            "**Current ceiling:** invariants I1–I27.\n\n## I26 — old\n",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("SECURITY-INVARIANTS.md"))).toBe(true);
  });
});

/**
 * `auditWriteRouteSurface` had no test at all: the fixture repos above omit
 * `http-write-routes.ts`, so `readAll` opts the whole check out and every case
 * passes without exercising it. These fixtures supply both sides.
 *
 * The docs it reads now include the two `.claude/commands/` skills, added after
 * both drifted while the two `docs/` files it already covered stayed honest —
 * `nimbus-http-write-surface.md` said "Fourteen entries" over a code block
 * listing twelve, and `nimbus-federation-identity.md` said "3 of 6 routes".
 */
function withWriteRoutes(overrides: Record<string, string> = {}): Record<string, string> {
  const src = [
    'const ROUTE_A = "POST /v1/a";',
    'const ROUTE_B = "POST /v1/b";',
    "export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([",
    "  ROUTE_A,",
    "  ROUTE_B,",
    "]);",
    "",
  ].join("\n");
  const enumerated = [
    "## The Allowlist",
    "",
    "Two entries:",
    "",
    "```typescript",
    "export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([",
    '  "POST /v1/a",',
    '  "POST /v1/b",',
    "]);",
    "```",
    "",
  ].join("\n");
  return inSync({
    "packages/gateway/src/ipc/http-write-routes.ts": src,
    "docs/SECURITY-INVARIANTS.md":
      "**Current ceiling:** invariants I1–I27.\n\n## I27 — the share gate\n\n" +
      "The `WRITE_ROUTE_ALLOWLIST` carries `POST /v1/a` and `POST /v1/b`.\n",
    "docs/cli-reference.md": "**Write endpoints**\n`POST /v1/a` `POST /v1/b`\nAll read endpoints\n",
    ".claude/commands/nimbus-http-write-surface.md": enumerated,
    ".claude/commands/nimbus-federation-identity.md":
      "SCIM is 1 of 2 routes on the `WRITE_ROUTE_ALLOWLIST`.\n",
    ...overrides,
  });
}

describe("auditStatusDrift — the I13 write surface across docs AND skills", () => {
  test("passes when every doc and skill agrees with the code", () => {
    const result = auditStatusDrift(makeRepo(withWriteRoutes()));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("flags a SPELLED count below ten — the range the mapping used to omit", () => {
    // The regression this pins: SPELLED and the alternation both started at "ten", so a doc
    // claiming "Three entries" over a two-route allowlist matched nothing, was never attributed
    // to this allowlist, and passed. The gate did not fail on the stale claim — it could not see
    // it. Small counts are exactly where a hand-maintained allowlist starts, so this was the
    // range most likely to be wrong and least likely to be caught.
    const wrongCount = [
      "## The Allowlist",
      "",
      "Three entries:",
      "",
      "```typescript",
      "export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([",
      '  "POST /v1/a",',
      '  "POST /v1/b",',
      "]);",
      "```",
      "",
    ].join("\n");
    const result = auditStatusDrift(
      makeRepo(withWriteRoutes({ ".claude/commands/nimbus-http-write-surface.md": wrongCount })),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("nimbus-http-write-surface.md") && e.includes("Three entries"),
      ),
    ).toBe(true);
  });

  test("accepts a correct spelled count below ten", () => {
    // The other half: now that small counts are visible, an ACCURATE small count must still
    // pass. Without this, the fix above could be satisfied by flagging every spelled count.
    const result = auditStatusDrift(makeRepo(withWriteRoutes()));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("flags a route missing from the skill's transcribed constant", () => {
    const short = [
      "## The Allowlist",
      "",
      "Two entries:",
      "",
      "```typescript",
      "export const WRITE_ROUTE_ALLOWLIST: readonly string[] = Object.freeze([",
      '  "POST /v1/a",',
      "]);",
      "```",
      "",
      "| Route | Auth |",
      "| `POST /v1/b` | bearer |",
      "",
    ].join("\n");
    const result = auditStatusDrift(
      makeRepo(withWriteRoutes({ ".claude/commands/nimbus-http-write-surface.md": short })),
    );
    expect(result.ok).toBe(false);
    // The auth table below still names `POST /v1/b`, so a whole-file `includes`
    // would report this clean — the scope narrowing is what catches it.
    expect(
      result.errors.some(
        (e) => e.includes("nimbus-http-write-surface.md") && e.includes("POST /v1/b"),
      ),
    ).toBe(true);
  });

  test("flags a NUMERIC stale count, the form the federation skill drifted in", () => {
    const result = auditStatusDrift(
      makeRepo(
        withWriteRoutes({
          ".claude/commands/nimbus-federation-identity.md":
            "SCIM is 1 of 6 routes on the `WRITE_ROUTE_ALLOWLIST`.\n",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes("nimbus-federation-identity.md") && e.includes("6 routes"),
      ),
    ).toBe(true);
  });

  test("does not demand a full enumeration from a doc that only states a count", () => {
    // `nimbus-federation-identity.md` names no routes at all. Requiring them
    // there would flag a document that is not lying about anything.
    const result = auditStatusDrift(makeRepo(withWriteRoutes()));
    expect(result.errors.some((e) => e.includes("nimbus-federation-identity.md"))).toBe(false);
  });
});

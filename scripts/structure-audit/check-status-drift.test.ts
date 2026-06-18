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

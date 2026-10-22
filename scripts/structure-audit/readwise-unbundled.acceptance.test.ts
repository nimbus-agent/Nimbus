/**
 * Acceptance for the Readwise unbundling (spec section 9.5): once Readwise ships as the signed
 * extension `com.nimbus.readwise`, the gateway source names it in exactly three places - the
 * catalog entry, the secrets manifest and the continuity table. Any other file that mentions it
 * is either a leftover of the bundled connector or a comment that will rot.
 *
 * Runs against the real tree, literally as the spec words it: every `packages/gateway/src` file
 * whose text contains the word (case-insensitive), minus tests and fixtures.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { REPO_ROOT } from "./lib.ts";

const EXPECTED = [
  "packages/gateway/src/connectors/connector-catalog.ts",
  "packages/gateway/src/connectors/connector-secrets-manifest.ts",
  "packages/gateway/src/extensions/continuity/continuity-table.ts",
];

function mentioning(): string[] {
  const out: string[] = [];
  for (const rel of new Glob("packages/gateway/src/**/*").scanSync({ cwd: REPO_ROOT })) {
    const norm = rel.replaceAll("\\", "/");
    if (norm.endsWith(".test.ts") || norm.includes("/__fixtures__/")) continue;
    let text: string;
    try {
      text = readFileSync(join(REPO_ROOT, norm), "utf8");
    } catch {
      continue;
    }
    if (/readwise/i.test(text)) out.push(norm);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

describe("readwise unbundling acceptance", () => {
  test("only the catalog, secrets manifest and continuity table name readwise", () => {
    expect(mentioning()).toEqual(EXPECTED);
  });
});

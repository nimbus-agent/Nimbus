import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

/**
 * The CodeRabbit config's effect — better review comments — is not machine
 * checkable, and this file does not pretend otherwise. What IS checkable is
 * that the config parses, carries the shape the four working satellite configs
 * share, and does not cite an invariant that has since been renumbered or
 * retired. That last one is the real risk: the config is prose instructions,
 * so a stale `I29` would silently teach the reviewer something false forever.
 */

const ROOT = join(import.meta.dir, "..", "..");
const CONFIG = join(ROOT, ".coderabbit.yaml");

function loadConfig(): Record<string, unknown> {
  const parsed: unknown = parse(readFileSync(CONFIG, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("config is not a mapping");
  return parsed as Record<string, unknown>;
}

interface InstructionEntry {
  path: string;
  instructions: string;
}

function instructionEntries(): InstructionEntry[] {
  const reviews = loadConfig()["reviews"] as Record<string, unknown>;
  return reviews["path_instructions"] as InstructionEntry[];
}

describe("the monorepo's .coderabbit.yaml", () => {
  test("exists — the four satellites have one and this repo carries the invariants", () => {
    expect(existsSync(CONFIG)).toBe(true);
  });

  test("parses as YAML and carries the satellite shape", () => {
    const c = loadConfig();
    expect(c["language"]).toBe("en-US");
    const reviews = c["reviews"] as Record<string, unknown>;
    expect(reviews["profile"]).toBe("chill");
    // Advisory by design: CodeRabbit is not a required check, and a false
    // positive must never block a merge.
    expect(reviews["request_changes_workflow"]).toBe(false);
    expect(Array.isArray(reviews["path_instructions"])).toBe(true);
  });

  test("every path_instructions entry has a real path and non-trivial instructions", () => {
    const entries = instructionEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(typeof e.path).toBe("string");
      // `typeof` before `.length`: the TS cast is erased at runtime, and an
      // ARRAY of 80+ elements would satisfy a bare length check while being an
      // invalid CodeRabbit instruction value.
      expect(typeof e.instructions).toBe("string");
      expect(e.instructions.length).toBeGreaterThan(80);
      // The glob's first literal segment must exist on disk, so a renamed
      // directory cannot leave an instruction silently matching nothing.
      const literal = e.path.split("/**")[0]?.split("/*")[0] ?? "";
      if (literal && !literal.includes("*")) {
        expect(existsSync(join(ROOT, literal))).toBe(true);
      }
    }
  });

  test("every invariant cited in an instruction exists in docs/SECURITY-INVARIANTS.md", () => {
    const doc = readFileSync(join(ROOT, "docs", "SECURITY-INVARIANTS.md"), "utf8");

    // Real invariants are `## I<n> — ...` headings. Mentions elsewhere in the
    // doc include a worked example for adding the NEXT invariant, which must
    // not count as existing.
    const defined = new Set(
      [...doc.matchAll(/^##\s+(I\d+)\b/gm)].map((m) => m[1]).filter((x): x is string => !!x),
    );
    expect(defined.size).toBeGreaterThan(20);

    // Scan the PARSED instruction values with a bare `\bI\d+\b`, not the raw
    // YAML for parenthesised ids. The narrower form only saw `(I2)` and would
    // have let `enforce I31` or `(I30/I31)` through — precisely the stale
    // guidance this test exists to catch. Parsing also scopes the scan to
    // instructions, so the file's header comment (which legitimately mentions
    // the I1-I35 range and the reserved I28) is not swept in.
    const cited = new Set(
      instructionEntries().flatMap((e) =>
        [...e.instructions.matchAll(/\bI\d+\b/g)].map((m) => m[0]),
      ),
    );
    expect(cited.size).toBeGreaterThan(0);

    const unknown = [...cited].filter((i) => !defined.has(i));
    expect(unknown).toEqual([]);
  });

  test("no path_instruction tells the reviewer to enforce the reserved I28", () => {
    // I28 is reserved for a parked branch, not a live defense. The file's header
    // comment may SAY that (it is useful context for whoever edits this next);
    // what must not happen is an instruction asking the reviewer to enforce it.
    const offending = instructionEntries().filter((e) => /\bI28\b/.test(e.instructions));
    expect(offending).toEqual([]);
  });
});

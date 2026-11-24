import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `nimbus pre-review` is READ-ONLY and model-free in its core (spec § 6). Pinned here rather than by a static
 * rule: no file under `prreview/` (fixtures and tests excepted) may import a connector value, the executor, the
 * egress ledger, a model module, or the synthesis runner, use a network primitive, or call a SQL write helper.
 */

const DIR = import.meta.dir;

function sources(): Array<{ name: string; text: string }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ name: f, text: readFileSync(join(DIR, f), "utf8") }));
}

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["a connector module", /from\s+["'][^"']*\/connectors\/(?!pr-meta)[^"']*["']/],
  ["the executor", /from\s+["'][^"']*\/engine\/[^"']*["']/],
  ["the egress ledger", /from\s+["'][^"']*\/egress\/[^"']*["']/],
  ["a model module", /from\s+["'][^"']*\/llm\/[^"']*["']/],
  ["the synthesis runner", /synthesi[sz]/i],
  ["a network primitive", /\bfetch\s*\(|Bun\.connect|node:net|node:http|node:https|WebSocket/],
  ["a SQL write helper", /\bdbRun\b|\bdbExec\b|\bdbStmtRun\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/],
];

describe("prreview/ confinement", () => {
  test("the directory has the files this pin covers", () => {
    expect(sources().map((s) => s.name)).toContain("prreview-build.ts");
  });

  for (const [what, re] of FORBIDDEN) {
    test(`no source imports or uses ${what}`, () => {
      const hits = sources()
        .filter((s) => re.test(s.text))
        .map((s) => s.name);
      expect(hits).toEqual([]);
    });
  }
});

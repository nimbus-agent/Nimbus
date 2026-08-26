import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../structure-audit/lib.ts";

/**
 * The PR cross-platform legs and the macOS/Windows push leg must run the SAME `bun test`
 * package list.
 *
 * They did not, from whenever `pr-quality-cross-platform` was introduced until 2026-08-23. The
 * PR leg ran `bun test packages/<pkg>/src`; the push leg ran
 * `bun test packages/gateway packages/cli scripts` in one process. The
 * difference was not academic — over the 200 CI runs on `main` between 2026-08-02 and
 * 2026-08-22, 50 failed, 35 had a failing macOS job, and 33 of those 35 were in files the PR
 * gate never loaded at all (`scripts/`, `test/integration/`, `test/e2e/`). Every one of them was
 * discovered after merge, because there was no earlier place they COULD be discovered.
 *
 * A comment saying "keep these in sync" is not a mechanism; the two commands sit in different
 * files, ~500 lines apart, and each has its own dense rationale block that reads complete on its
 * own. This is the mechanism.
 *
 * Deliberately narrow: it compares the POSITIONAL path arguments only. Flags legitimately
 * differ — the push leg adds Istanbul coverage preloads and a JUnit reporter that the PR leg has
 * no use for, and the PR leg wraps its attempt in `run-with-timeout.ts`. What must not drift is
 * WHICH TESTS RUN.
 */

const CI_YML = join(REPO_ROOT, ".github", "workflows", "ci.yml");
const TEST_SUITE_YML = join(REPO_ROOT, ".github", "workflows", "_test-suite.yml");

/**
 * Positional (non-flag) arguments of a `bun test …` invocation on one line.
 *
 * Stops at the first token that starts with `-` or a redirect, which is where the paths end in
 * both invocations. Returns `undefined` when the line has no `bun test` at all.
 */
function bunTestPaths(line: string): readonly string[] | undefined {
  const marker = " bun test ";
  const at = line.indexOf(marker);
  if (at === -1) {
    return undefined;
  }
  const rest = line.slice(at + marker.length).trim();
  const paths: string[] = [];
  for (const token of rest.split(/\s+/)) {
    if (token.startsWith("-") || token.startsWith(">") || token.startsWith("2>")) {
      break;
    }
    paths.push(token.replace(/^["']|["']$/g, ""));
  }
  return paths;
}

/** Every line of `file` matching `predicate`, as a list — so "exactly one" is assertable. */
function matchingLines(file: string, predicate: (line: string) => boolean): readonly string[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => predicate(l));
}

describe("PR cross-platform legs run the same tests as the push matrix", () => {
  // Identified by the wall-clock wrapper, which is unique to this step in ci.yml. Keying on
  // the step NAME would break the moment the step is renamed; keying on `packages/…` would
  // match any future `bun test` added to the file.
  const prLines = matchingLines(CI_YML, (l) => l.includes("run-with-timeout.ts 900 bun test"));

  // Identified by the JUnit outfile, which names the unit shard and appears exactly once.
  const pushLines = matchingLines(
    TEST_SUITE_YML,
    (l) => l.includes(" bun test ") && l.includes("junit-reports/junit-unit.xml"),
  );

  test("each command is found exactly once", () => {
    // A zero match would make the parity assertion below vacuously true — the classic shape of
    // a gate that cannot fail. Assert presence before asserting equality.
    expect(prLines).toHaveLength(1);
    expect(pushLines).toHaveLength(1);
  });

  test("the two invocations name the same test paths", () => {
    const pr = bunTestPaths(prLines[0] ?? "");
    const push = bunTestPaths(pushLines[0] ?? "");
    expect(pr).toBeDefined();
    expect(push).toBeDefined();
    expect(pr).toEqual(push as readonly string[]);
  });

  test("the shared path list is whole-repo, not scoped to src", () => {
    // The specific regression this file exists to prevent: a `/src` suffix silently drops every
    // `test/integration/`, `test/e2e/` and `test/unit/` file from the run, and — because
    // `mock.module` is process-global — changes which mocks are registered for the files that
    // DO run. Both halves of that mattered; see #1311.
    // Asserted on BOTH lists, not just one plus the equality above. Equality alone would let a
    // change that scoped both legs identically pass two of these three tests; and checking only
    // the push side would leave the PR side resting on equality. Each list stands on its own.
    for (const paths of [
      bunTestPaths(prLines[0] ?? "") ?? [],
      bunTestPaths(pushLines[0] ?? "") ?? [],
    ]) {
      expect(paths).toContain("packages/gateway");
      expect(paths).toContain("packages/cli");
      expect(paths).toContain("scripts");
      // `packages/mcp-connectors` was in this list until the connectors were extracted to their
      // own repository. It is asserted ABSENT rather than simply dropped: a path that no longer
      // exists would make `bun test` exit non-zero on both legs, so re-adding it is a mistake the
      // equality check above cannot catch — both lists would agree, and both would be wrong.
      expect(paths).not.toContain("packages/mcp-connectors");
      for (const p of paths) {
        expect(p.endsWith("/src")).toBe(false);
      }
    }
  });
});

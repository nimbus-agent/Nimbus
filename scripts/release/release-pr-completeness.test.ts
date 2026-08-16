import { describe, expect, test } from "bun:test";
import {
  addedChangelogLines,
  checkCompleteness,
  descriptionOf,
  droppedFromChangelog,
  userFacingSubjects,
} from "./release-pr-completeness.ts";

/**
 * The real v2.4.6 range. Reproduced verbatim rather than invented, because the whole point of this
 * guard is a case that already happened and that every existing check reported as healthy.
 */
const V246_SUBJECTS = [
  "fix(docs): derive four drifted invariant claims instead of hand-maintaining them (#1221)",
  "fix(security): wire the two I22/I18 defenses that were resolved but never read (#1220)",
  "test(security): make five invariant enforcement tests capable of failing (#1219)",
  "fix(security): widen D12 past its receiver-name blind spot and D22(d) past its flat-path one (#1218)",
  "test(security): floor the static structure auditor so a broken scan cannot report clean (#1217)",
  "test(security): close the I23(c) subdirectory blind spot and floor both D17 scans (#1216)",
  "refactor(cli): collapse eleven copies of the gateway-connect lifecycle into one (#1215)",
  "test(perf): 🧪 add empty array edge case tests to poolTrimmedSamples (#1214)",
] as const;

/** What release-please actually generated for v2.4.6 — #1218 absent. */
const V246_CHANGELOG_PATCH = [
  "@@ -1,5 +1,13 @@",
  " # Changelog",
  "+## [2.4.6](https://github.com/nimbus-agent/Nimbus/compare/v2.4.5...v2.4.6) (2026-08-16)",
  "+",
  "+### Bug Fixes",
  "+",
  "+* **docs:** derive four drifted invariant claims instead of hand-maintaining them ([#1221](https://github.com/nimbus-agent/Nimbus/issues/1221)) ([6fc59e5](https://github.com/nimbus-agent/Nimbus/commit/6fc59e5))",
  "+* **security:** wire the two I22/I18 defenses that were resolved but never read ([#1220](https://github.com/nimbus-agent/Nimbus/issues/1220)) ([84d3e62](https://github.com/nimbus-agent/Nimbus/commit/84d3e62))",
].join("\n");

const filesWith = (patch: string) => [
  { filename: "CHANGELOG.md", patch },
  {
    filename: ".release-please-manifest.json",
    patch: '@@ -1 +1 @@\n-  ".": "2.4.5"\n+  ".": "2.4.6"',
  },
];

describe("userFacingSubjects", () => {
  test("selects only feat/fix, with scope and bang variants", () => {
    const got = userFacingSubjects([
      "feat: a",
      "feat(scope): b",
      "fix!: c",
      "fix(scope)!: d",
      "test(security): e",
      "refactor(cli): f",
      "chore: release main",
      "docs: g",
    ]).map((c) => c.subject);
    expect(got).toEqual(["feat: a", "feat(scope): b", "fix!: c", "fix(scope)!: d"]);
  });

  test("captures the squash PR reference", () => {
    expect(userFacingSubjects(["fix(security): x (#1218)"])[0]?.pr).toBe("1218");
    expect(userFacingSubjects(["fix(security): x"])[0]?.pr).toBeUndefined();
  });

  test("a BODY line that looks like a conventional header is not counted", () => {
    // The caller passes subjects, but this pins the intent: over-counting makes the guard fire on
    // healthy runs, and a guard that cries wolf gets deleted rather than obeyed. This very file
    // contains `fix(security):` strings inside prose.
    expect(userFacingSubjects(["  fix: indented, so not a subject"])).toEqual([]);
  });
});

describe("descriptionOf", () => {
  test("strips type, scope, bang and the PR reference", () => {
    expect(descriptionOf("fix(security): widen D12 past its blind spot (#1218)")).toBe(
      "widen D12 past its blind spot",
    );
    expect(descriptionOf("feat!: a thing")).toBe("a thing");
  });
});

describe("addedChangelogLines", () => {
  test("takes only added lines, only from CHANGELOG files", () => {
    const added = addedChangelogLines(filesWith(V246_CHANGELOG_PATCH));
    expect(added).toContain("#1221");
    expect(added).not.toContain('".": "2.4.5"'); // a different file
    expect(added).not.toContain("# Changelog"); // a context line, not an addition
  });

  test("returns empty when the PR touches no changelog", () => {
    expect(addedChangelogLines([{ filename: "package.json", patch: "@@\n+x" }])).toBe("");
  });
});

describe("droppedFromChangelog", () => {
  test("matches on the PR number, so #121 cannot vouch for #1218", () => {
    // Substring matching would let a shorter number match inside a longer one, or the reverse.
    const commits = userFacingSubjects(["fix: a (#121)"]);
    expect(droppedFromChangelog(commits, "* a ([#1218](x/issues/1218))")).toHaveLength(1);
  });

  test("falls back to the description for a commit with no PR reference", () => {
    const commits = userFacingSubjects(["fix(security): a direct push with no ref"]);
    expect(droppedFromChangelog(commits, "* **security:** a direct push with no ref")).toEqual([]);
    expect(droppedFromChangelog(commits, "* **security:** something else")).toHaveLength(1);
  });
});

describe("checkCompleteness — the v2.4.6 incident", () => {
  test("catches #1218 being dropped from the real generated changelog", () => {
    const result = checkCompleteness({
      subjects: [...V246_SUBJECTS],
      releasePrFiles: filesWith(V246_CHANGELOG_PATCH),
      tag: "v2.4.5",
    });
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(3); // three fix commits in the range
    expect(result.errors.join("\n")).toContain("#1218");
    // Names the one that is missing, and not the two that are present.
    expect(result.errors.join("\n")).not.toContain("#1220");
    expect(result.errors.join("\n")).not.toContain("#1221");
  });

  test("passes once the missing entry is added — the remedy actually clears it", () => {
    // A guard nobody can satisfy is as bad as one nobody can trip.
    const fixed = `${V246_CHANGELOG_PATCH}\n+* **security:** widen D12 ([#1218](https://github.com/nimbus-agent/Nimbus/issues/1218))`;
    const result = checkCompleteness({
      subjects: [...V246_SUBJECTS],
      releasePrFiles: filesWith(fixed),
      tag: "v2.4.5",
    });
    expect(result.ok).toBe(true);
  });

  test("the test/refactor/chore commits in the same range are never demanded", () => {
    // #1216, #1217, #1219 are `test:` and #1215 is `refactor:` — release-please omits them by
    // design, so demanding them would make this guard permanently red.
    const complete = [
      V246_CHANGELOG_PATCH,
      "+* **security:** widen D12 ([#1218](x/issues/1218))",
    ].join("\n");
    const result = checkCompleteness({
      subjects: [...V246_SUBJECTS],
      releasePrFiles: filesWith(complete),
      tag: "v2.4.5",
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(3);
  });
});

describe("checkCompleteness — the cases that must NOT fire", () => {
  test("no release PR open: silent, because the existing drop-guard owns that case", () => {
    const result = checkCompleteness({ subjects: [...V246_SUBJECTS], tag: "v2.4.5" });
    expect(result.ok).toBe(true);
  });

  test("no user-facing commits: silent", () => {
    const result = checkCompleteness({
      subjects: ["test: a (#1)", "chore: release main (#2)"],
      releasePrFiles: filesWith("@@\n+## [2.4.6]"),
      tag: "v2.4.5",
    });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(0);
  });

  test("a release PR that adds NO changelog lines fails loudly rather than passing", () => {
    // The degenerate shape: the check reads an empty string and every `includes` would be false,
    // so without this arm the message would blame each commit individually instead of the scan.
    const result = checkCompleteness({
      subjects: ["fix: a (#1)"],
      releasePrFiles: [{ filename: "package.json", patch: "@@\n+x" }],
      tag: "v2.4.5",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("adds no CHANGELOG lines");
  });
});

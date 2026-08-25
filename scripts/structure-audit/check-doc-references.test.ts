import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import {
  DOCS_EXCLUDED_PREFIXES,
  DOCS_GLOBS,
  DOCS_TREE_GLOBS,
  extractMarkdownLinks,
  isExcludedDoc,
  maskInlineCode,
} from "./check-doc-references.ts";

const REPO_ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The bug this file exists for: every `DOCS_GLOBS` pattern lives under
 * `.claude/`, and `Bun.Glob.scan` skips dot-directories unless `dot: true` is
 * passed. The glob was declared, matched nothing, and the gate reported "all
 * resolve" over only its hardcoded list — so 21 skill files went unchecked for
 * as long as the glob existed.
 */
describe("DOCS_GLOBS — dot-directory scanning", () => {
  test("every glob targets a dot-directory, which is why dot:true is required", () => {
    expect(DOCS_GLOBS.length).toBeGreaterThan(0);
    for (const pattern of DOCS_GLOBS) expect(pattern.startsWith(".")).toBe(true);
  });

  test("scanning WITHOUT dot:true finds nothing — the original defect", () => {
    for (const pattern of DOCS_GLOBS) {
      const hits = [...new Glob(pattern).scanSync({ cwd: REPO_ROOT })];
      expect(hits).toHaveLength(0);
    }
  });

  test("scanning WITH dot:true finds the skill files", () => {
    let total = 0;
    for (const pattern of DOCS_GLOBS) {
      total += [...new Glob(pattern).scanSync({ cwd: REPO_ROOT, dot: true })].length;
    }
    // Deliberately a floor, not an equality: skills get added and removed, and a
    // brittle count would fail for the wrong reason. Zero is the failure mode
    // that matters.
    expect(total).toBeGreaterThan(10);
  });
});

/**
 * `DOCS_FILES` was a hand-maintained list of 16 paths, so ~40 files under
 * `docs/` were never opened by this gate — long enough for
 * `docs/internals/test-fixtures.md` to point at a directory that does not
 * exist. `DOCS_TREE_GLOBS` closes that; `DOCS_EXCLUDED_PREFIXES` is the small,
 * reasoned set that stays out.
 */
describe("DOCS_TREE_GLOBS — the rest of docs/", () => {
  test("scans the docs tree, which is NOT a dot-directory", () => {
    expect(DOCS_TREE_GLOBS.length).toBeGreaterThan(0);
    for (const pattern of DOCS_TREE_GLOBS) expect(pattern.startsWith("docs/")).toBe(true);
  });

  test("finds substantially more than the 16 hand-listed docs", () => {
    // A floor, not an equality: docs come and go. The failure mode that
    // matters is the glob silently matching nothing, as DOCS_GLOBS once did.
    let total = 0;
    for (const pattern of DOCS_TREE_GLOBS) {
      total += [...new Glob(pattern).scanSync({ cwd: REPO_ROOT })].length;
    }
    expect(total).toBeGreaterThan(40);
  });

  test("excludes exactly the reasoned set, by exact path or directory prefix", () => {
    expect(isExcludedDoc("docs/CHANGELOG.md")).toBe(true);
    expect(isExcludedDoc("docs/superpowers/plans/anything.md")).toBe(true);
    expect(isExcludedDoc("docs/roadmap.md")).toBe(true);
    expect(isExcludedDoc("docs/structure-audit/baseline.md")).toBe(true);
    // Not excluded: a sibling of an excluded file must not be swept in with it.
    expect(isExcludedDoc("docs/structure-audit/sonarqube-rule-tuning.md")).toBe(false);
    expect(isExcludedDoc("docs/testing.md")).toBe(false);
    expect(isExcludedDoc("docs/internals/test-fixtures.md")).toBe(false);
  });

  test("an exact-path exclusion does not act as a prefix", () => {
    // "docs/roadmap.md" must not silence a hypothetical "docs/roadmap.md.bak".
    expect(isExcludedDoc("docs/roadmap.md.bak")).toBe(false);
  });

  test("the exclusion set stays small — every entry needs a stated reason", () => {
    expect(DOCS_EXCLUDED_PREFIXES.length).toBeLessThanOrEqual(8);
  });
});

describe("maskInlineCode", () => {
  test("blanks span contents", () => {
    const span = "`foo/bar.ts`";
    expect(maskInlineCode(`see ${span} now`)).toBe(`see ${" ".repeat(span.length)} now`);
  });

  test("preserves length exactly, so byte offsets still map to the right line", () => {
    const text = "a `b` c\n`d`\nplain";
    expect(maskInlineCode(text)).toHaveLength(text.length);
    // Newlines outside spans must survive, or the line reporter drifts.
    expect(maskInlineCode(text).split("\n")).toHaveLength(3);
  });

  test("leaves text outside spans untouched", () => {
    expect(maskInlineCode("[real](docs/a.md)")).toBe("[real](docs/a.md)");
  });
});

describe("extractMarkdownLinks", () => {
  test("finds a real markdown link", () => {
    const found = [...extractMarkdownLinks("see [docs](docs/roadmap.md) here")];
    expect(found.map((f) => f.raw)).toEqual(["docs/roadmap.md"]);
  });

  /**
   * `nimbus-file-map.md` describes this very gate as catching "broken
   * `[text](path)` and backtick path refs". Read literally that is a link to a
   * file named `path`, and the gate reported it as a broken reference.
   */
  test("ignores a link that is quoted inside an inline code span", () => {
    const line = "Doc-ref drift audit (broken `[text](path)` and backtick path refs)";
    expect([...extractMarkdownLinks(line)]).toHaveLength(0);
  });

  test("still finds a real link on a line that also quotes syntax", () => {
    const line = "syntax is `[text](path)` — see [the map](docs/architecture.md)";
    expect([...extractMarkdownLinks(line)].map((f) => f.raw)).toEqual(["docs/architecture.md"]);
  });

  test("reports an offset that lands on the right line", () => {
    const text = "line one\nline two\nsee [x](docs/a.md)";
    const [hit] = [...extractMarkdownLinks(text)];
    expect(hit).toBeDefined();
    expect(text.slice(0, hit?.offset ?? 0).split("\n")).toHaveLength(3);
  });
});

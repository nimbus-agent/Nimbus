import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { DOCS_GLOBS, extractMarkdownLinks, maskInlineCode } from "./check-doc-references.ts";

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

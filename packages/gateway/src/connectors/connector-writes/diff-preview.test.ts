// packages/gateway/src/connectors/connector-writes/diff-preview.test.ts
// The `diff` preview kind (D1c): declaration rules, the pre-diff path list, the rendered prompt.
import { describe, expect, test } from "bun:test";
import { renderUnifiedDiff } from "./diff.ts";
import { buildConnectorWritePreviewFrom, renderConnectorWritePreviewLines } from "./preview.ts";
import {
  type BoundWrite,
  row as makeRow,
  type PreviewFieldTemplate,
  textField,
  withBound,
  withPreview,
} from "./types.ts";

const IDS: ReadonlySet<string> = new Set(["synth_commit_prepare"]);
const DIFF_FIELD: PreviewFieldTemplate = { key: "files", label: "Files", kind: "diff" };

function bound(over: Partial<BoundWrite["prepare"]> = {}): BoundWrite {
  return {
    prepare: {
      tool: "synth_commit_prepare",
      argKeys: ["repo", "files"],
      args: (i) => ({ repo: i["repo"], files: i["files"] }),
      select: () => [{ label: "Head", value: "abc" }],
      budgetMs: 1000,
      maxInputBytes: 1000,
      maxReplyBytes: 1000,
      diff: { files: () => [], maxOldBytes: 100, maxDiffBytes: 100 },
      ...over,
    },
    binds: [{ field: "expectedHeadSha", from: () => "x" }],
  };
}

const previewed = (fields: PreviewFieldTemplate[]) =>
  withPreview(makeRow("synth_commit", "github.file.commit", "mesh", 4), {
    target: "{repo}",
    summary: "Commit to {repo}",
    fields,
  });

describe("the diff field kind: declaration rules", () => {
  test("two diff fields are refused at withPreview", () => {
    expect(() => previewed([DIFF_FIELD, { ...DIFF_FIELD, key: "other" }])).toThrow(
      /at most one diff field/,
    );
  });

  test("a diff field and a prepare diff together are accepted", () => {
    const r = withBound(previewed([textField("repo"), DIFF_FIELD]), bound(), IDS);
    expect(r.bound?.prepare.diff).toBeDefined();
  });

  test("a diff field without prepare.diff is refused", () => {
    const b = bound();
    const { diff: _omit, ...prepare } = b.prepare;
    expect(() =>
      withBound(previewed([textField("repo"), DIFF_FIELD]), { ...b, prepare }, IDS),
    ).toThrow(/has a diff field but the prepare read has no diff/);
  });

  test("prepare.diff without a diff field is refused", () => {
    expect(() =>
      withBound(previewed([textField("repo"), textField("files")]), bound(), IDS),
    ).toThrow(/preview has no diff field/);
  });

  test("the diff field must be one of the prepare argKeys", () => {
    expect(() =>
      withBound(previewed([textField("repo"), DIFF_FIELD]), bound({ argKeys: ["repo"] }), IDS),
    ).toThrow(/diff field files is not a prepare argKey/);
  });

  test("the diff caps must be positive integers", () => {
    expect(() =>
      withBound(
        previewed([textField("repo"), DIFF_FIELD]),
        bound({ diff: { files: () => [], maxOldBytes: 0, maxDiffBytes: 100 } }),
        IDS,
      ),
    ).toThrow(/diff maxOldBytes must be a positive integer/);
  });
});

describe("the builder shows the diff field as a path list", () => {
  const row = withBound(previewed([textField("repo"), DIFF_FIELD]), bound(), IDS);
  const build = (files: unknown) =>
    buildConnectorWritePreviewFrom(
      {
        type: "github.file.commit",
        payload: { mcpToolId: "synth_commit", input: { repo: "r", files } },
      },
      [row],
    );

  test("sanitised paths and a count", () => {
    const p = build([
      { path: "a/b.ts", content: "SECRET-BODY" },
      { path: "c‮.md", content: "x" },
    ]);
    const files = p?.fields.find((f) => f.label === "Files");
    expect(files?.kind).toBe("diff");
    expect(files?.value).toBe("2 files: a/b.ts, c\\u{202E}.md");
    expect(JSON.stringify(p)).not.toContain("SECRET-BODY");
  });

  test("one file is singular", () => {
    expect(build([{ path: "a", content: "x" }])?.fields[1]?.value).toBe("1 file: a");
  });

  test("a malformed value is shown as it is, quoted", () => {
    expect(build("nope")?.fields[1]?.value).toBe('"nope"');
    expect(build([{ nopath: 1 }])?.fields[1]?.value).toBe('[{"nopath":1}]');
  });

  test("the builder never sets a diff", () => {
    expect(build([{ path: "a", content: "x" }])).not.toHaveProperty("diff");
  });
});

describe("the prompt lines carry the diff last, with a footer", () => {
  const row = withBound(previewed([textField("repo"), DIFF_FIELD]), bound(), IDS);
  const base = buildConnectorWritePreviewFrom(
    {
      type: "github.file.commit",
      payload: { mcpToolId: "synth_commit", input: { repo: "r", files: [] } },
    },
    [row],
  );
  if (base === undefined) throw new Error("no preview");

  const diffOf = (files: Parameters<typeof renderUnifiedDiff>[0]) => {
    const r = renderUnifiedDiff(files);
    if (!r.ok) throw new Error("too large");
    return r.diff;
  };

  test("golden: a new, a modified and an unchanged file", () => {
    const diff = diffOf([
      { path: "n.txt", oldContent: undefined, newContent: "hello\n", mode: "100644" },
      { path: "m.txt", oldContent: "a\nb\n", newContent: "a\nB\n", mode: "100644" },
      { path: "u.txt", oldContent: "same\n", newContent: "same\n", mode: "100644" },
    ]);
    const lines = renderConnectorWritePreviewLines({
      ...base,
      prepared: { status: "ok", fields: [{ label: "Head", value: "abc" }] },
      diff,
    });
    const at = lines.indexOf("Prepared:");
    expect(lines.slice(at)).toEqual([
      "Prepared:",
      "  Head: abc",
      "",
      "=== n.txt (new file, mode 100644)",
      "--- /dev/null",
      "+++ b/n.txt",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "=== m.txt (modified, mode 100644)",
      "--- a/m.txt",
      "+++ b/m.txt",
      "@@ -1,2 +1,2 @@",
      " a",
      "-b",
      "+B",
      "=== u.txt (no change, mode 100644)",
      "End of diff: 3 files, +2 -1",
    ]);
  });

  test("a preview with no diff renders no diff section", () => {
    expect(renderConnectorWritePreviewLines(base).join("\n")).not.toContain("End of diff");
  });

  test("a tab inside a line shows as \\t, and no line holds a raw control character", () => {
    const diff = diffOf([
      {
        path: "p\u001b[2Jq",
        oldContent: undefined,
        newContent: "a\tb\r\nc‮d\u001b]0;x\u0007\n",
      },
    ]);
    const lines = renderConnectorWritePreviewLines({ ...base, diff });
    for (const l of lines) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence
      expect(l).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    }
    expect(lines.join("\n")).toContain("+a\\tb\\u{000D}");
    expect(lines.at(-1)).toBe("End of diff: 1 file, +2 -0");
  });
});

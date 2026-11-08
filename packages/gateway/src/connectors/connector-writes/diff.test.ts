// packages/gateway/src/connectors/connector-writes/diff.test.ts
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type DiffInputFile, diffTextLines, type PreviewDiff, renderUnifiedDiff } from "./diff.ts";
import { escapeDiffText } from "./sanitise.ts";

function render(files: DiffInputFile[], opts?: Parameters<typeof renderUnifiedDiff>[1]) {
  const r = renderUnifiedDiff(files, opts);
  if (!r.ok) throw new Error(`diff refused: ${r.reason}`);
  return r;
}

const f = (path: string, oldContent: string | undefined, newContent: string, mode?: string) =>
  ({
    path,
    oldContent,
    newContent,
    ...(mode === undefined ? {} : { mode }),
  }) satisfies DiffInputFile;

/** A tiny patch applier: the rendered hunks, applied to the (sanitised) old text, give the new text. */
function applyHunks(oldText: string, file: PreviewDiff["files"][number]): string {
  if (file.state === "unchanged") return oldText;
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  // A trailing "\n" yields a final "" element: it is the end of the last line, not a line.
  const hadFinalEol = oldText.endsWith("\n");
  if (hadFinalEol) oldLines.pop();
  const out: Array<{ text: string; eol: boolean }> = [];
  let pos = 0;
  const lastKept = (): { text: string; eol: boolean } | undefined => out[out.length - 1];
  for (const h of file.hunks) {
    const copyTo = h.oldLines > 0 ? h.oldStart - 1 : h.oldStart;
    while (pos < copyTo) {
      out.push({ text: oldLines[pos] as string, eol: pos < oldLines.length - 1 || hadFinalEol });
      pos++;
    }
    let lastOp = "";
    for (const l of h.lines) {
      if (l.op === "\\") {
        if (lastOp !== "-") {
          const last = lastKept();
          if (last !== undefined) last.eol = false;
        }
        continue;
      }
      lastOp = l.op;
      if (l.op === " ") {
        out.push({ text: l.text, eol: true });
        pos++;
      } else if (l.op === "-") {
        pos++;
      } else {
        out.push({ text: l.text, eol: true });
      }
    }
  }
  while (pos < oldLines.length) {
    out.push({ text: oldLines[pos] as string, eol: pos < oldLines.length - 1 || hadFinalEol });
    pos++;
  }
  return out.map((l) => l.text + (l.eol ? "\n" : "")).join("");
}

function counts(d: PreviewDiff["files"][number]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const h of d.hunks)
    for (const l of h.lines) {
      if (l.op === "+") add++;
      if (l.op === "-") del++;
    }
  return { add, del };
}

describe("renderUnifiedDiff: states and hunks", () => {
  test("a new file is all additions with a zero-length old side", () => {
    const { diff } = render([f("a.txt", undefined, "one\ntwo\n", "100644")]);
    const file = diff.files[0];
    expect(file?.state).toBe("new");
    expect(file?.mode).toBe("100644");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
    expect(file?.hunks).toEqual([
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: [
          { op: "+", text: "one" },
          { op: "+", text: "two" },
        ],
      },
    ]);
  });

  test("a single changed line carries three lines of context each side", () => {
    const old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    const neu = "1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n";
    const { diff } = render([f("a", old, neu)]);
    const h = diff.files[0]?.hunks;
    expect(h).toHaveLength(1);
    expect(h?.[0]).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(h?.[0]?.lines.map((l) => l.op + l.text)).toEqual([
      " 2",
      " 3",
      " 4",
      "-5",
      "+FIVE",
      " 6",
      " 7",
      " 8",
    ]);
  });

  test("two far-apart changes are two hunks; changes within six lines merge into one", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${String(i)}`);
    const edit = (idx: number[]) =>
      lines.map((l, i) => (idx.includes(i) ? `${l}x` : l)).join("\n") + "\n";
    const old = `${lines.join("\n")}\n`;
    expect(render([f("a", old, edit([2, 25]))]).diff.files[0]?.hunks).toHaveLength(2);
    // Gap of exactly six unchanged lines touches (3 + 3 of context): one hunk.
    expect(render([f("a", old, edit([5, 12]))]).diff.files[0]?.hunks).toHaveLength(1);
    // Seven unchanged lines between them: two hunks.
    expect(render([f("a", old, edit([5, 13]))]).diff.files[0]?.hunks).toHaveLength(2);
  });

  test("an identical file is unchanged with no hunks", () => {
    const { diff } = render([f("a", "same\n", "same\n")]);
    expect(diff.files[0]).toMatchObject({ state: "unchanged", additions: 0, deletions: 0 });
    expect(diff.files[0]?.hunks).toEqual([]);
  });

  test("empty to content and content to empty", () => {
    const a = render([f("a", "", "x\ny\n")]).diff.files[0];
    expect(a?.state).toBe("modified");
    expect(counts(a as never)).toEqual({ add: 2, del: 0 });
    const b = render([f("b", "x\ny\n", "")]).diff.files[0];
    expect(counts(b as never)).toEqual({ add: 0, del: 2 });
    expect(b?.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });

  test("a new empty file is listed and has no hunks", () => {
    const file = render([f("e", undefined, "")]).diff.files[0];
    expect(file).toMatchObject({ state: "new", additions: 0, hunks: [] });
  });

  test("first and last line changes", () => {
    const { diff } = render([f("a", "a\nb\nc\n", "A\nb\nC\n")]);
    expect(counts(diff.files[0] as never)).toEqual({ add: 2, del: 2 });
    expect(applyHunks("a\nb\nc\n", diff.files[0] as never)).toBe("A\nb\nC\n");
  });

  test("no trailing newline: the marker follows the line that lacks it", () => {
    const { diff } = render([f("a", "a\nb", "a\nb\n")]);
    const lines = diff.files[0]?.hunks[0]?.lines.map((l) => l.op + l.text);
    expect(lines).toEqual([" a", "-b", "\\No newline at end of file", "+b"]);
    const both = render([f("a", "a\nb", "a\nB")]).diff.files[0]?.hunks[0]?.lines.map(
      (l) => l.op + l.text,
    );
    expect(both).toEqual([
      " a",
      "-b",
      "\\No newline at end of file",
      "+B",
      "\\No newline at end of file",
    ]);
  });

  test("a CRLF file keeps its carriage returns, shown escaped; CRLF to LF changes every line", () => {
    const { diff } = render([f("a", "x\r\ny\r\n", "x\ny\n")]);
    const lines = diff.files[0]?.hunks[0]?.lines.map((l) => l.op + l.text);
    expect(lines).toEqual(["-x\\u{000D}", "-y\\u{000D}", "+x", "+y"]);
    expect(diffTextLines(diff).join("\n")).not.toContain("\r");
  });

  test("a tab is escaped like every other control (U+0009), never kept raw", () => {
    const { diff } = render([f("a", undefined, "a\tb\n")]);
    expect(diff.files[0]?.hunks[0]?.lines[0]?.text).toBe("a\\u{0009}b");
  });

  test("the escaping is injective: a real character and its typed-out escape render differently", () => {
    const text = (content: string) => {
      const { diff } = render([f("a", undefined, `${content}\n`)]);
      return diff.files[0]?.hunks[0]?.lines[0]?.text;
    };
    // real U+202E vs the literal text \u{202E}
    expect(text("\u202e")).toBe("\\u{202E}");
    expect(text("\\u{202E}")).toBe("\\\\u{202E}"); // cross-platform-ok: an escape sequence, not a path
    // real tab vs literal \t and vs literal \u{0009}
    expect(text("\t")).not.toBe(text("\\t"));
    expect(text("\t")).not.toBe(text("\\u{0009}"));
    // real CR vs literal \u{000D}
    expect(text("\r")).toBe("\\u{000D}");
    expect(text("\\u{000D}")).toBe("\\\\u{000D}"); // cross-platform-ok: an escape sequence, not a path
    // a backslash alone is doubled, and the mapping has no collisions over a mixed set
    expect(text("a\\b")).toBe("a\\\\b");
    const samples = ["\t", "\\t", "\r", "\\r", "\\u{000D}", "\\", "\\\\", "\u202e", "\\u{202E}"];
    expect(new Set(samples.map(text)).size).toBe(samples.length);
  });

  test("every invisible or format character is escaped, in lines, paths and modes", () => {
    const hidden = [
      "­", // soft hyphen (Cf)
      "؀",
      "؅",
      "۝",
      "܏",
      "￹",
      "￻",
      "\u{1d173}",
      "\u{1d17a}",
      " ",
      " ",
      "\u200b",
      "\u200d",
      "\u2060",
      "\ufeff",
      "︀",
      "️",
      "\u{e0100}",
      "\u{e01ef}",
      "͏",
      "ᅟ",
      "ᅠ",
      "ㅤ",
      "ﾠ",
      "⠀",
      "\u0000",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u009f",
    ];
    for (const ch of hidden) {
      const { diff } = render([f(`p${ch}q`, `o${ch}\n`, `n${ch}\n`, `m${ch}`)]);
      const out = diffTextLines(diff).join("\n");
      expect(out.includes(ch), `U+${ch.codePointAt(0)?.toString(16)}`).toBe(false);
      expect(out).toContain("\\u{");
    }
  });

  test("every unsafe class is escaped in paths, modes and lines", () => {
    const unsafe = [
      "\u001b[31m",
      "\u0007",
      "\u009b",
      "\u007f",
      "\u202e",
      "\u2066",
      "\u200b",
      "\ufeff",
      " ",
      "\u{e0041}",
    ];
    for (const u of unsafe) {
      const { diff } = render([f(`p${u}q`, `o${u}\n`, `n${u}\n`, `m${u}`)]);
      const text = diffTextLines(diff).join("\n");
      expect(text).not.toContain(u);
      expect(text).toContain("\\u{");
      expect(diff.files[0]?.path).toBe(escapeDiffText(`p${u}q`));
      expect(diff.files[0]?.mode).toBe(escapeDiffText(`m${u}`));
    }
  });

  test("a 32 KiB single-line file renders (one line, no hunks beyond one)", () => {
    const old = `${"a".repeat(32 * 1024)}\n`;
    const neu = `${"b".repeat(32 * 1024)}\n`;
    const r = renderUnifiedDiff([f("big", old, neu)], { maxBytes: 200_000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.diff.files[0]?.hunks).toHaveLength(1);
  });

  test("20 files render; the totals are the sums", () => {
    const files = Array.from({ length: 20 }, (_, i) => f(`d/${String(i)}.txt`, "a\n", "b\n"));
    const { diff } = render(files);
    expect(diff.files).toHaveLength(20);
    expect(diff.additions).toBe(20);
    expect(diff.deletions).toBe(20);
  });

  test("the output is deterministic and the sha256 is over the rendered text", () => {
    const files = [f("a", "x\n", "y\n"), f("b", undefined, "z\n", "100644")];
    const one = render(files).diff;
    const two = render(files).diff;
    expect(two).toEqual(one);
    const text = diffTextLines(one).join("\n");
    expect(one.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(one.bytes).toBe(new TextEncoder().encode(text).length);
  });
});

describe("renderUnifiedDiff: the property (apply the hunks, get the new text)", () => {
  // A small deterministic PRNG so a failure reproduces.
  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const ATOMS = ["a", "b", "c", "", "  ", "x y", "tab\there", "dup", "dup", "\r", "é"];
  function randomText(rand: () => number): string {
    const n = Math.floor(rand() * 14);
    const lines = Array.from(
      { length: n },
      () => ATOMS[Math.floor(rand() * ATOMS.length)] as string,
    );
    const eol = rand() < 0.7 ? "\n" : "";
    return lines.length === 0 ? "" : lines.join("\n") + eol;
  }

  test("500 random pairs round-trip, and the counts equal the +/- lines", () => {
    const rand = rng(12345);
    for (let i = 0; i < 500; i++) {
      const oldText = randomText(rand);
      const newText = rand() < 0.3 ? oldText.replace("dup", "DUP") : randomText(rand);
      const { diff } = render([f("p", oldText, newText)]);
      const file = diff.files[0];
      if (file === undefined) throw new Error("no file");
      const got = applyHunks(escapeDiffText(oldText), file);
      expect(got, `case ${String(i)}: ${JSON.stringify([oldText, newText])}`).toBe(
        escapeDiffText(newText),
      );
      const c = counts(file);
      expect(file.additions).toBe(c.add);
      expect(file.deletions).toBe(c.del);
      if (oldText === newText) expect(file.state).toBe("unchanged");
    }
  });

  test("a new file round-trips from the empty text", () => {
    const rand = rng(99);
    for (let i = 0; i < 100; i++) {
      const text = randomText(rand);
      const { diff } = render([f("p", undefined, text)]);
      const file = diff.files[0];
      if (file === undefined) throw new Error("no file");
      expect(applyHunks("", file)).toBe(escapeDiffText(text));
    }
  });
});

describe("renderUnifiedDiff: the step budget", () => {
  test("an adversarial pair falls back to a whole-file replacement within the budget", () => {
    const old = "a\n".repeat(16 * 1024);
    const neu = "b\n".repeat(16 * 1024);
    const r = render([f("adv", old, neu)], { maxBytes: 10_000_000 });
    expect(r.steps).toBeLessThanOrEqual(2_000_000 + 40_000);
    expect(r.fallbackFiles).toBe(1);
    const file = r.diff.files[0];
    expect(file?.deletions).toBe(16 * 1024);
    expect(file?.additions).toBe(16 * 1024);
    if (file === undefined) throw new Error("no file");
    expect(applyHunks(old, file)).toBe(neu);
  });

  test("the budget is shared across files: a later file falls back once it is spent", () => {
    const mk = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${String(i)}`).join("\n") + "\n";
    const files = [
      f("one", mk(300, "o"), mk(300, "p")),
      f("two", mk(300, "o"), mk(300, "p")),
      f("three", mk(300, "o"), mk(300, "p")),
    ];
    const r = render(files, { stepBudget: 150_000, maxBytes: 10_000_000 });
    expect(r.fallbackFiles).toBeGreaterThanOrEqual(1);
    for (const [i, file] of r.diff.files.entries()) {
      expect(applyHunks(files[i]?.oldContent as string, file)).toBe(files[i]?.newContent as string);
    }
  });

  test("a typical small edit does not fall back", () => {
    const old = Array.from({ length: 800 }, (_, i) => `line ${String(i)}`).join("\n") + "\n";
    const neu = old.replace("line 400", "line 400 changed");
    const r = render([f("t", old, neu)]);
    expect(r.fallbackFiles).toBe(0);
    expect(r.diff.files[0]?.hunks).toHaveLength(1);
  });
});

describe("renderUnifiedDiff: the size cap refuses, never truncates", () => {
  test("over the cap returns tooLarge; at the cap passes", () => {
    const files = [f("a", undefined, "x".repeat(2000))];
    const r = render(files, { maxBytes: 1_000_000 });
    const bytes = r.diff.bytes;
    expect(renderUnifiedDiff(files, { maxBytes: bytes }).ok).toBe(true);
    const over = renderUnifiedDiff(files, { maxBytes: bytes - 1 });
    expect(over).toEqual({ ok: false, reason: "tooLarge" });
  });

  test("the default cap is 65,536 bytes", () => {
    const at = renderUnifiedDiff([f("a", undefined, "x".repeat(70_000))]);
    expect(at).toEqual({ ok: false, reason: "tooLarge" });
  });

  test("bytes count UTF-8, not characters", () => {
    const one = render([f("a", undefined, "€".repeat(10))], { maxBytes: 1_000_000 }).diff;
    const asc = render([f("a", undefined, "x".repeat(10))], { maxBytes: 1_000_000 }).diff;
    expect(one.bytes - asc.bytes).toBe(20);
  });
});

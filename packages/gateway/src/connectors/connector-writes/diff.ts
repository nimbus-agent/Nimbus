// packages/gateway/src/connectors/connector-writes/diff.ts
// The unified diff a bound multi-file write shows its approver (Phase 9.7 D1c, I54, static rule
// D42(g)). PURE: it builds the diff from exactly two things, the caller's NEW text (what the
// connector will write, byte for byte) and the BEFORE text the prepare reply carried. Nothing a
// connector says about the change ("diff", "patch", "hunks", "summary") is ever read, so the plus
// lines are exact by construction; only `engine/prepare-step.ts` calls {@link renderUnifiedDiff}.
//
// Lines split on "\n" only (a CR stays on its line and is shown escaped). A line is equal only when
// its text AND its end-of-line agree, so a missing final newline shows as the standard
// `\ No newline at end of file`. The common prefix and suffix are stripped, then Myers O(ND) runs on
// the middle under a fixed total step budget; a file that exhausts it is shown as a whole-file
// replacement (every old line `-`, every new line `+`), which is longer but still shows everything.
// A diff over the byte cap is REFUSED, never truncated.

import { createHash } from "node:crypto";
import { escapeDiffText } from "./sanitise.ts";

/** The default byte cap of the rendered, sanitised diff text (`commit-limits.ts` pins it equal). */
export const DIFF_DEFAULT_MAX_BYTES = 65_536;
/** The default total Myers step budget across all files of one diff. */
export const DIFF_DEFAULT_STEP_BUDGET = 2_000_000;
const CONTEXT = 3;

/** One file of a change: the BEFORE text (`undefined`: the file does not exist) and the AFTER text. */
export interface DiffInputFile {
  readonly path: string;
  readonly oldContent: string | undefined;
  readonly newContent: string;
  /** A label for the file's mode (`100644`, `executable`); shown, never interpreted. */
  readonly mode?: string;
}

export type DiffOp = " " | "+" | "-" | "\\";

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export type DiffFileState = "new" | "modified" | "unchanged";

export interface DiffFile {
  readonly path: string;
  readonly state: DiffFileState;
  readonly mode?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly hunks: readonly DiffHunk[];
}

/** Plain JSON, gateway-built. `bytes` and `sha256` are over {@link diffTextLines} joined by "\n". */
export interface PreviewDiff {
  readonly files: readonly DiffFile[];
  readonly additions: number;
  readonly deletions: number;
  readonly bytes: number;
  readonly sha256: string;
}

export type DiffOutcome =
  | {
      readonly ok: true;
      readonly diff: PreviewDiff;
      /** Myers steps spent (capped at the budget) and files shown as a whole-file replacement. */
      readonly steps: number;
      readonly fallbackFiles: number;
    }
  | { readonly ok: false; readonly reason: "tooLarge" };

export interface DiffOptions {
  readonly maxBytes?: number;
  readonly stepBudget?: number;
}

interface SourceLine {
  readonly text: string;
  readonly eol: boolean;
}

/** Split on "\n" only; a final segment with no "\n" is a line that lacks its end-of-line. */
function splitLines(text: string): SourceLine[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const last = parts.pop() as string;
  const lines: SourceLine[] = parts.map((t) => ({ text: t, eol: true }));
  if (last !== "") lines.push({ text: last, eol: false });
  return lines;
}

const keyOf = (l: SourceLine): string => (l.eol ? `${l.text}\n` : l.text);

interface Edit {
  readonly op: " " | "+" | "-";
  readonly line: SourceLine;
}

/** The edit script of the middle by Myers O(ND), or `undefined` when the budget ran out. */
function myers(a: readonly string[], b: readonly string[], budget: { left: number }) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  // Myers: the end is always reached by d = n + m, so this initial value is never used.
  let found = max;
  let reached = false;
  for (let d = 0; d <= max && !reached; d++) {
    for (let k = -d; k <= d; k += 2) {
      if (budget.left <= 0) return undefined;
      budget.left -= 1;
      let x: number;
      if (k === -d || (k !== d && (v[k - 1 + off] as number) < (v[k + 1 + off] as number))) {
        x = v[k + 1 + off] as number;
      } else {
        x = (v[k - 1 + off] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + off] = x;
      if (x >= n && y >= m) {
        found = d;
        reached = true;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  // Backtrack: a list of moves from the end, each "=", "+" (insert b[i]) or "-" (delete a[i]).
  const moves: Array<{ op: " " | "+" | "-"; i: number }> = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const k = x - y;
    const down =
      k === -d || (k !== d && (prev[k - 1 + d - 1] as number) < (prev[k + 1 + d - 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + d - 1] as number;
    const prevY = prevX - prevK;
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) {
      x--;
      y--;
      moves.push({ op: " ", i: x });
    }
    if (down) {
      moves.push({ op: "+", i: prevY });
    } else {
      moves.push({ op: "-", i: prevX });
    }
    x = prevX;
    y = prevY;
  }
  // At d = 0 the path is the common prefix, which the caller stripped: (x, y) is (0, 0) here.
  moves.reverse();
  return moves;
}

/** Every old line `-`, every new line `+`. */
function wholeReplacement(a: readonly SourceLine[], b: readonly SourceLine[]): Edit[] {
  return [
    ...a.map((line) => ({ op: "-" as const, line })),
    ...b.map((line) => ({ op: "+" as const, line })),
  ];
}

/** The full edit script of `a` -> `b`, and whether it fell back to a whole-file replacement. */
function editScript(
  a: readonly SourceLine[],
  b: readonly SourceLine[],
  budget: { left: number },
): { edits: Edit[]; fellBack: boolean } {
  let prefix = 0;
  while (
    prefix < a.length &&
    prefix < b.length &&
    keyOf(a[prefix] as SourceLine) === keyOf(b[prefix] as SourceLine)
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    keyOf(a[a.length - 1 - suffix] as SourceLine) === keyOf(b[b.length - 1 - suffix] as SourceLine)
  ) {
    suffix++;
  }
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  const head: Edit[] = a.slice(0, prefix).map((line) => ({ op: " ", line }));
  const tail: Edit[] = a.slice(a.length - suffix).map((line) => ({ op: " ", line }));
  let mid: Edit[];
  let fellBack = false;
  if (midA.length === 0 || midB.length === 0) {
    mid = wholeReplacement(midA, midB);
  } else {
    const moves = myers(midA.map(keyOf), midB.map(keyOf), budget);
    if (moves === undefined) {
      mid = wholeReplacement(midA, midB);
      fellBack = true;
    } else {
      mid = moves.map((mv) =>
        mv.op === "+"
          ? { op: "+", line: midB[mv.i] as SourceLine }
          : { op: mv.op, line: midA[mv.i] as SourceLine },
      );
    }
  }
  return { edits: [...head, ...mid, ...tail], fellBack };
}

/** Hunks of an edit script: {@link CONTEXT} lines of context, merged when they touch or overlap. */
function buildHunks(edits: readonly Edit[]): DiffHunk[] {
  const changed: number[] = [];
  edits.forEach((e, i) => {
    if (e.op !== " ") changed.push(i);
  });
  if (changed.length === 0) return [];
  // Group the changes whose gap of unchanged lines is at most 2 * CONTEXT.
  const groups: Array<[number, number]> = [];
  for (const i of changed) {
    const g = groups[groups.length - 1];
    if (g !== undefined && i - g[1] - 1 <= 2 * CONTEXT) g[1] = i;
    else groups.push([i, i]);
  }
  // Position (lines consumed so far) on each side at every edit index.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let n = 0;
  for (const e of edits) {
    oldBefore.push(o);
    newBefore.push(n);
    if (e.op !== "+") o++;
    if (e.op !== "-") n++;
  }
  return groups.map(([first, last]) => {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(edits.length - 1, last + CONTEXT);
    const lines: DiffLine[] = [];
    let oldLines = 0;
    let newLines = 0;
    for (let i = from; i <= to; i++) {
      const e = edits[i] as Edit;
      lines.push({ op: e.op, text: escapeDiffText(e.line.text) });
      if (e.op !== "+") oldLines++;
      if (e.op !== "-") newLines++;
      if (!e.line.eol) lines.push({ op: "\\", text: "No newline at end of file" });
    }
    const oldPos = oldBefore[from] as number;
    const newPos = newBefore[from] as number;
    return {
      oldStart: oldLines > 0 ? oldPos + 1 : oldPos,
      oldLines,
      newStart: newLines > 0 ? newPos + 1 : newPos,
      newLines,
      lines,
    };
  });
}

function countOps(hunks: readonly DiffHunk[], op: "+" | "-"): number {
  let c = 0;
  for (const h of hunks) for (const l of h.lines) if (l.op === op) c++;
  return c;
}

/** The text of the diff exactly as it is shown, one entry per line (no footer). */
export function diffTextLines(diff: PreviewDiff): string[] {
  const out: string[] = [];
  for (const file of diff.files) {
    const mode = file.mode === undefined ? "" : `, mode ${file.mode}`;
    const label =
      file.state === "new" ? "new file" : file.state === "unchanged" ? "no change" : "modified";
    out.push(`=== ${file.path} (${label}${mode})`);
    if (file.state === "unchanged") continue;
    out.push(file.state === "new" ? "--- /dev/null" : `--- a/${file.path}`, `+++ b/${file.path}`);
    for (const h of file.hunks) {
      out.push(
        `@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`,
      );
      for (const l of h.lines) out.push(l.op === "\\" ? `\\ ${l.text}` : `${l.op}${l.text}`);
    }
  }
  return out;
}

/**
 * The unified diff of `files`, or `tooLarge` when its rendered text exceeds `maxBytes` UTF-8 bytes.
 * Deterministic: the same input gives the same diff and the same `sha256`.
 */
export function renderUnifiedDiff(
  files: readonly DiffInputFile[],
  opts: DiffOptions = {},
): DiffOutcome {
  const budget = { left: opts.stepBudget ?? DIFF_DEFAULT_STEP_BUDGET };
  const total = budget.left;
  let fallbackFiles = 0;
  const shown: DiffFile[] = files.map((file) => {
    const isNew = file.oldContent === undefined;
    const before = splitLines(file.oldContent ?? "");
    const after = splitLines(file.newContent);
    const path = escapeDiffText(file.path);
    const mode = file.mode === undefined ? {} : { mode: escapeDiffText(file.mode) };
    if (!isNew && file.oldContent === file.newContent) {
      return { path, state: "unchanged", ...mode, additions: 0, deletions: 0, hunks: [] };
    }
    const { edits, fellBack } = editScript(before, after, budget);
    if (fellBack) fallbackFiles++;
    const hunks = buildHunks(edits);
    return {
      path,
      state: isNew ? "new" : "modified",
      ...mode,
      additions: countOps(hunks, "+"),
      deletions: countOps(hunks, "-"),
      hunks,
    };
  });
  const base = {
    files: shown,
    additions: shown.reduce((s, f) => s + f.additions, 0),
    deletions: shown.reduce((s, f) => s + f.deletions, 0),
  };
  const text = diffTextLines({ ...base, bytes: 0, sha256: "" }).join("\n");
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > (opts.maxBytes ?? DIFF_DEFAULT_MAX_BYTES)) return { ok: false, reason: "tooLarge" };
  return {
    ok: true,
    diff: { ...base, bytes, sha256: createHash("sha256").update(text).digest("hex") },
    steps: total - Math.max(budget.left, 0),
    fallbackFiles,
  };
}

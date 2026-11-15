/**
 * A small unified line diff for showing the owner what `nimbus agent install` would change
 * (Phase 28 AD7b). Configuration files are short, so a plain longest-common-subsequence table is
 * enough; a file too large for one is shown whole as removed and added rather than cut.
 */
import { normaliseNewlines } from "./plan-files.ts";

const CONTEXT = 3;
/** Above this many table cells the diff falls back to whole-file remove and add. */
const MAX_CELLS = 4_000_000;

type Op = { readonly tag: " " | "-" | "+"; readonly line: string };

function linesOf(text: string | null): string[] {
  if (text === null || text === "") return [];
  const flat = normaliseNewlines(text);
  return (flat.endsWith("\n") ? flat.slice(0, -1) : flat).split("\n");
}

/** `noUncheckedIndexedAccess` makes every read optional; these are the only two fallbacks. */
function lineAt(lines: readonly string[], at: number): string {
  return lines[at] ?? "";
}

function cellAt(table: Uint32Array, at: number): number {
  return table[at] ?? 0;
}

function ops(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line) => ({ tag: "-" as const, line })),
      ...b.map((line) => ({ tag: "+" as const, line })),
    ];
  }
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        lineAt(a, i) === lineAt(b, j)
          ? cellAt(table, (i + 1) * w + j + 1) + 1
          : Math.max(cellAt(table, (i + 1) * w + j), cellAt(table, i * w + j + 1));
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (lineAt(a, i) === lineAt(b, j)) {
      out.push({ tag: " ", line: lineAt(a, i) });
      i += 1;
      j += 1;
    } else if (cellAt(table, (i + 1) * w + j) >= cellAt(table, i * w + j + 1)) {
      out.push({ tag: "-", line: lineAt(a, i) });
      i += 1;
    } else {
      out.push({ tag: "+", line: lineAt(b, j) });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ tag: "-", line: lineAt(a, i) });
  for (; j < b.length; j += 1) out.push({ tag: "+", line: lineAt(b, j) });
  return out;
}

/**
 * The changed lines of `before` to `after`, each with three lines of context, `...` between
 * separate groups. Line endings are not compared. An unchanged file gives an empty string.
 */
export function unifiedDiff(before: string | null, after: string): string {
  const all = ops(linesOf(before), linesOf(after));
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((op, at) => {
    if (op.tag === " ") return;
    const from = Math.max(0, at - CONTEXT);
    const to = Math.min(all.length - 1, at + CONTEXT);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });
  const out: string[] = [];
  let last = -1;
  all.forEach((op, at) => {
    if (!keep[at]) return;
    if (last !== -1 && at !== last + 1) out.push("...");
    out.push(`${op.tag} ${op.line}`);
    last = at;
  });
  return out.join("\n");
}

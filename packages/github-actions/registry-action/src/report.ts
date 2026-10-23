/**
 * Where `check` and `sign` report: workflow annotations, the job summary and the step log. Behind
 * one interface so tests can capture what a reviewer would see.
 */
import { emitAnnotation, writeJobSummary } from "../../shared/gha-io.ts";

export interface ActionIo {
  annotate: (level: "warning" | "error", message: string) => void;
  summary: (markdown: string) => void;
  log: (line: string) => void;
}

export const GHA_IO: ActionIo = {
  annotate: emitAnnotation,
  summary: writeJobSummary,
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * `s` as a Markdown inline code span. Manifest strings are the publisher's, so nothing in them may
 * render as Markdown or HTML in the summary: a code span renders neither, its fence is longer than
 * any backtick run inside, and control characters (newlines included) become spaces so a span
 * cannot end its list item.
 */
export function code(s: string): string {
  const flat = s.replace(CONTROL_CHARS, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = longest > 0 ? " " : "";
  return `${fence}${pad}${flat}${pad}${fence}`;
}

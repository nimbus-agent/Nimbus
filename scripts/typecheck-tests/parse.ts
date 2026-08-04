// scripts/typecheck-tests/parse.ts

/** `file (POSIX-relative) -> (TS error code -> count)`. */
export type ErrorCounts = Map<string, Map<string, number>>;

/**
 * One `tsc --noEmit` diagnostic line looks like:
 *   packages/gateway/test/a.ts(12,3): error TS2554: Expected 5 arguments, but got 3.
 * Continuation lines (indented explanations) carry no `(line,col): error TSxxxx:` and are skipped.
 */
const LINE_RE = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/;

/**
 * Paths are normalized to forward slashes regardless of host OS. `tsc` already emits forward
 * slashes on Windows in practice, but the baseline is generated on a developer machine and
 * validated inside a Linux container — a separator mismatch there would fail every key at once.
 */
export function parseTscOutput(raw: string, repoRoot?: string): ErrorCounts {
  const rootPrefix =
    repoRoot === undefined ? undefined : `${repoRoot.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  const out: ErrorCounts = new Map();
  for (const line of raw.split("\n")) {
    const m = LINE_RE.exec(line);
    if (m === null) continue;
    let file = (m[1] ?? "").replaceAll("\\", "/").trim();
    // Strip an absolute prefix if tsc emitted one. Keys MUST be repo-relative: the baseline is
    // generated on a developer machine (C:/gitrep/Nimbus/...) and validated inside a container
    // (/src/...). An absolute key would mismatch every entry at once and read as total regression.
    if (rootPrefix !== undefined && file.startsWith(rootPrefix))
      file = file.slice(rootPrefix.length);
    const code = m[4] ?? "";
    if (file === "" || code === "") continue;
    let byCode = out.get(file);
    if (byCode === undefined) {
      byCode = new Map();
      out.set(file, byCode);
    }
    byCode.set(code, (byCode.get(code) ?? 0) + 1);
  }
  return out;
}

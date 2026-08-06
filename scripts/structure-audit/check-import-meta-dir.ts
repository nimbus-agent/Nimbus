#!/usr/bin/env bun
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { stripComments } from "./lib.ts";

export const GATEWAY_SRC = resolve(import.meta.dir, "..", "..", "packages", "gateway", "src");

/**
 * The single module allowed to derive a filesystem path from its own module URL. It exists to
 * answer "am I a compiled binary?" and to build self-spawn commands; every other module gets its
 * paths from it or from an embedded `{ type: "file" }` asset import.
 */
const CANONICAL_MODULE = "platform/runtime-layout.ts";

/**
 * Dev-only by construction: these spawn source entrypoints out of a source tree that a released
 * binary does not carry, and nothing in a release build reaches them.
 */
const DEV_ONLY_PREFIX = "perf/surfaces/";

/**
 * Forms of `import.meta` that yield a FILESYSTEM PATH. In a `bun build --compile` binary they all
 * point into the virtual root (`/$bunfs/root`; `B:\~BUN\root` on Windows), so walking up from one
 * produces a path that does not exist — the defect this cluster exists to remove.
 *
 * `import.meta.url` on its own is deliberately NOT here:
 * `new Worker(new URL("./worker.ts", import.meta.url))` is the form Bun's bundler rewrites and
 * embeds, and `db/query-guard.ts` + `embedding/worker-bridge.ts` depend on it. Only its
 * path-producing use — `fileURLToPath(import.meta.url)` — is forbidden.
 *
 * These are matched against the WHOLE comment-stripped source, not line by line, and every
 * separator tolerates whitespace. A line-by-line scan misses the formatter-produced shape
 * `fileURLToPath(\n  import.meta.url,\n)` — measured: it passed the audit silently — which would
 * let the very defect class this gate exists to close walk straight back in.
 */
const FORBIDDEN: readonly RegExp[] = [
  /\bimport\s*\.\s*meta\s*\.\s*(?:dir|dirname|path|file)\b/g,
  // `[,)]`, not `,?\s*\)`: `fileURLToPath(import.meta.url, { windows: false })` is a valid
  // path-producing call (Node's two-arg form), and anchoring on the closing paren missed it.
  /\bfileURLToPath\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*[,)]/g,
];

/**
 * Blank the CONTENTS of string and regex literals, preserving length and newlines so match
 * offsets and line numbers stay exact.
 *
 * `stripComments` deliberately preserves string literals, so without this a source file holding
 * the literal `"import.meta.dir"` — an error message, a doc string — would be reported as a
 * violation. A template literal's `${...}` substitutions are NOT blanked: `` `${import.meta.dir}/x` ``
 * is real code and must still be caught.
 *
 * Regex literals are skipped too, which `stripComments` does not do. That matters in the other
 * direction: `str.replace(/"/g, "")` would otherwise open a phantom string and blank the real code
 * that follows — a silent FALSE NEGATIVE in a gate whose whole job is to not miss one.
 */
export function blankLiterals(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  // A `/` starts a regex (not division) when the previous non-space token can't end an operand.
  const regexAllowedAfter = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);
  const templateStack: number[] = []; // ${} nesting depth per open template literal
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i] as string;
    if (c === "'" || c === '"') {
      const start = ++i;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      blank(start, i);
      i += 1;
      prev = c;
      continue;
    }
    if (c === "`") {
      const start = ++i;
      while (i < src.length) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "`") break;
        if (src[i] === "$" && src[i + 1] === "{") break;
        i += 1;
      }
      blank(start, i);
      if (src[i] === "$") {
        templateStack.push(0);
        i += 2; // step over `${` into the substitution — code, so keep scanning normally
      } else {
        i += 1;
      }
      prev = "`";
      continue;
    }
    if (c === "}" && templateStack.length > 0) {
      const depth = templateStack[templateStack.length - 1] as number;
      if (depth === 0) {
        // Closing a substitution: resume template-literal text.
        templateStack.pop();
        const start = ++i;
        while (i < src.length) {
          if (src[i] === "\\") {
            i += 2;
            continue;
          }
          if (src[i] === "`") break;
          if (src[i] === "$" && src[i + 1] === "{") break;
          i += 1;
        }
        blank(start, i);
        if (src[i] === "$") {
          templateStack.push(0);
          i += 2;
        } else {
          i += 1;
        }
        prev = "`";
        continue;
      }
      templateStack[templateStack.length - 1] = depth - 1;
    } else if (c === "{" && templateStack.length > 0) {
      templateStack[templateStack.length - 1] = (templateStack[templateStack.length - 1] ?? 0) + 1;
    }
    if (c === "/" && (prev === "" || regexAllowedAfter.has(prev))) {
      const start = ++i;
      let closed = false;
      while (i < src.length && src[i] !== "\n") {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === "[") {
          while (i < src.length && src[i] !== "]" && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
        }
        if (src[i] === "/") {
          closed = true;
          break;
        }
        i += 1;
      }
      if (closed) {
        blank(start, i);
        i += 1;
        prev = "/";
        continue;
      }
      i = start; // not a regex after all (e.g. division); fall through
    }
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join("");
}

export interface PathDerivationViolation {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

function* walkTypeScript(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTypeScript(full);
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      yield full;
    }
  }
}

/**
 * The complete skip list — four entries, each deliberate, NO production module among them:
 *   1. tests           — fixtures legitimately construct the forbidden shapes.
 *   2. `.d.ts`         — declarations emit nothing, so they derive no runtime path.
 *   3. `perf/surfaces/**` — bench drivers that spawn source entrypoints; unreachable from a build.
 *   4. `runtime-layout.ts` — the canonical module the rule confines derivation TO. This is the
 *      rule's definition, not an exemption from it; if it ever stops being the only such module,
 *      the constant is what has to change.
 * Enumerated here so the gate cannot silently grow a fifth.
 */
function isExempt(rel: string): boolean {
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return true;
  if (rel.endsWith(".d.ts")) return true;
  if (rel.startsWith(DEV_ONLY_PREFIX)) return true;
  return rel === CANONICAL_MODULE;
}

/** 1-based line of `index` within `source`. */
function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (source[i] === "\n") line++;
  }
  return line;
}

export function checkImportMetaDir(root: string = GATEWAY_SRC): PathDerivationViolation[] {
  const out: PathDerivationViolation[] = [];
  for (const full of walkTypeScript(root)) {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (isExempt(rel)) continue;
    // stripComments preserves newlines inside block comments and blankLiterals preserves length,
    // so offsets and line numbers stay exact through both passes. Matched against the WHOLE
    // source, not per line: see the note on FORBIDDEN.
    const src = blankLiterals(stripComments(readFileSync(full, "utf8")));
    for (const re of FORBIDDEN) {
      re.lastIndex = 0; // module-scope /g patterns: reset before each reuse
      for (const m of src.matchAll(re)) {
        out.push({
          file: rel,
          line: lineOf(src, m.index),
          snippet: m[0].replace(/\s+/g, " ").trim(),
        });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const violations = checkImportMetaDir();
  for (const v of violations) {
    console.error(
      `::error file=packages/gateway/src/${v.file},line=${String(v.line)}::` +
        "derives a filesystem path from import.meta — in a compiled binary this resolves inside " +
        "the read-only bunfs root and points at nothing. Use platform/runtime-layout.ts or an " +
        `embedded asset import instead. (${v.snippet})`,
    );
  }
  console.log(
    violations.length === 0
      ? "import.meta path confinement: ok"
      : `import.meta path confinement: ${String(violations.length)} violation(s)`,
  );
  process.exit(violations.length > 0 ? 1 : 0);
}

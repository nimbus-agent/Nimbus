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
  /\bfileURLToPath\s*\(\s*import\s*\.\s*meta\s*\.\s*url\s*,?\s*\)/g,
];

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
    // stripComments preserves newlines inside block comments, so line numbers stay accurate.
    // Matched against the WHOLE source, not per line: see the note on FORBIDDEN.
    const src = stripComments(readFileSync(full, "utf8"));
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

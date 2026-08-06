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
 */
const FORBIDDEN: readonly RegExp[] = [
  /\bimport\.meta\.(?:dir|dirname|path|file)\b/,
  /\bfileURLToPath\s*\(\s*import\.meta\.url\s*\)/,
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

function isExempt(rel: string): boolean {
  if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) return true;
  if (rel.endsWith(".d.ts")) return true;
  if (rel.startsWith(DEV_ONLY_PREFIX)) return true;
  return rel === CANONICAL_MODULE;
}

export function checkImportMetaDir(root: string = GATEWAY_SRC): PathDerivationViolation[] {
  const out: PathDerivationViolation[] = [];
  for (const full of walkTypeScript(root)) {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (isExempt(rel)) continue;
    // stripComments preserves newlines inside block comments, so line numbers stay accurate.
    const lines = stripComments(readFileSync(full, "utf8")).split("\n");
    lines.forEach((text, i) => {
      if (FORBIDDEN.some((re) => re.test(text))) {
        out.push({ file: rel, line: i + 1, snippet: text.trim() });
      }
    });
  }
  return out;
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

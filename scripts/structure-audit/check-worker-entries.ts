#!/usr/bin/env bun
/**
 * Every `new Worker(...)` in the gateway must take its path from `workers/embedded-workers.ts`.
 *
 * Written as what CANNOT pass, not as a sample of what may. Both of the gateway's worker spawn
 * sites — 2 of 2 — used `new Worker(new URL("./w.ts", import.meta.url))`, which resolves at
 * RUNTIME. The bundler never saw either worker, so `bun build --compile` produced a binary where
 * both threw `ModuleNotFound`. Semantic search (F15) and `nimbus query --sql` (F22) were dead in
 * every packaged release for the entire life of the project, and every source-tree test passed
 * throughout, because from source the `.ts` file really is there.
 *
 * That is why this is a static check rather than a runtime one: the failure is invisible to the
 * test suite by construction. A third worker added the obvious way would repeat it silently.
 *
 * The rule: in `packages/gateway/src`, a `new Worker(` argument must be an identifier exported by
 * `workers/embedded-workers.ts`. `new URL(...)` / `import.meta.url` / a string literal are all
 * rejected. `embedded-workers.ts` itself is the one file allowed to name the built artefacts.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const gatewaySrc = join(repoRoot, "packages", "gateway", "src");
const EMBEDDED_WORKERS = join(gatewaySrc, "workers", "embedded-workers.ts");

/**
 * Comments are stripped before scanning. Several of the files this guard protects EXPLAIN the
 * banned form in prose — `new Worker(new URL("./w.ts", import.meta.url))` appears in the doc
 * comment above both fixed spawn sites, and in `worker-entries.ts` itself. A guard that fires on
 * its own rationale is a guard nobody keeps.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** `new Worker(` up to the first `)` — enough to see what the first argument is. */
const NEW_WORKER = /new\s+Worker\s*\(([^)]*)/g;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...tsFilesUnder(abs));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(abs);
    }
  }
  return out;
}

/** Names `embedded-workers.ts` exports, so the guard tracks the manifest rather than a copy. */
export function exportedWorkerPathNames(embeddedWorkersSource: string): string[] {
  return [...embeddedWorkersSource.matchAll(/export const ([A-Z0-9_]+): string/g)].map(
    (m) => m[1] ?? "",
  );
}

export type WorkerViolation = { file: string; arg: string };

export function findWorkerViolations(
  files: ReadonlyArray<{ path: string; source: string }>,
  allowedNames: readonly string[],
): WorkerViolation[] {
  const violations: WorkerViolation[] = [];
  for (const f of files) {
    const pattern = new RegExp(NEW_WORKER.source, "g");
    for (const m of stripComments(f.source).matchAll(pattern)) {
      const arg = (m[1] ?? "").trim();
      if (!allowedNames.includes(arg)) {
        violations.push({ file: f.path, arg });
      }
    }
  }
  return violations;
}

function main(): void {
  const allowed = exportedWorkerPathNames(readFileSync(EMBEDDED_WORKERS, "utf-8"));
  if (allowed.length === 0) {
    process.stderr.write(
      "check-worker-entries: embedded-workers.ts exports no worker paths — the guard would pass vacuously.\n",
    );
    process.exit(1);
  }

  const files = tsFilesUnder(gatewaySrc)
    .filter((p) => p !== EMBEDDED_WORKERS)
    .map((p) => ({
      path: relative(repoRoot, p).split("\\").join("/"),
      source: readFileSync(p, "utf-8"),
    }));

  const violations = findWorkerViolations(files, allowed);
  if (violations.length > 0) {
    for (const v of violations) {
      process.stderr.write(
        `${v.file}: new Worker(${v.arg}) — a worker path must come from workers/embedded-workers.ts\n`,
      );
    }
    process.stderr.write(
      "\nA runtime-resolved worker URL is not bundled by `bun build --compile`: it works from source\n" +
        "and throws ModuleNotFound in every packaged build (F15, F22). Add the entry to\n" +
        "`packages/gateway/src/workers/worker-entries.ts`, export its path from `embedded-workers.ts`,\n" +
        "and spawn from that export.\n",
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-worker-entries: OK — every new Worker() uses one of: ${allowed.join(", ")}\n`,
  );
}

if (import.meta.main) {
  main();
}

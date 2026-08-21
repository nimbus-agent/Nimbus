/**
 * Every `new Worker()` entry point in the gateway, in one place.
 *
 * This exists because BOTH of the gateway's worker spawn sites were dead in every compiled
 * release, for the same reason, for the entire life of the project — F15 (semantic search) and
 * F22 (`nimbus query --sql`). `git log -S worker -- scripts/build-release.ts scripts/build-debug.ts`
 * returned no commits: no worker was ever passed to the build, so no worker was ever included.
 *
 * The mechanism: `new Worker(new URL("./worker.ts", import.meta.url))` resolves at RUNTIME, so the
 * bundler never sees the dependency. Measured on Bun 1.3.14, `--compile` does not follow that form
 * in EITHER the inline or the hoisted spelling, and passing the worker as a second entry point does
 * not help either — inside the binary `import.meta.url` is Bun's virtual root, where no `.ts` file
 * exists. Embedding the raw `.ts` with `{ type: "file" }` fails too: the path keeps its extension
 * but the Worker realm parses it as JavaScript and dies on the first type annotation.
 *
 * What works, and what this manifest drives: pre-bundle each entry to JavaScript, embed THAT with
 * `{ type: "file" }`, and hand the embedded path to `new Worker`. Same shape as the admin console
 * in `ipc/embedded-assets.ts`, which has always been embedded correctly.
 *
 * Adding a worker means adding a row here AND an export in `embedded-workers.ts`. The static audit
 * (`scripts/structure-audit/check-worker-entries.ts`) fails a `new Worker(` site that does not take
 * its path from `embedded-workers.ts`, so a third worker cannot repeat this silently.
 *
 * Paths are POSIX and relative to `packages/gateway/`; the build script joins them itself.
 */
export type WorkerEntry = {
  /** Basename of the emitted JS, without extension. Must match the `embedded-workers.ts` import. */
  readonly name: string;
  /** Entry TypeScript, relative to `packages/gateway/`. */
  readonly source: string;
};

export const WORKER_ENTRIES: readonly WorkerEntry[] = [
  { name: "query-guard-worker", source: "src/db/query-guard-worker.ts" },
  { name: "embedding-worker", source: "src/embedding/embedding-worker.ts" },
] as const;

/** Where `scripts/build-workers.ts` writes, relative to `packages/gateway/`. Gitignored. */
export const WORKER_OUT_DIR = "dist/workers";

// Bun [test].preload — after all tests in a `bun test` invocation, dump the raw
// istanbul coverage map to a JSON shard. A separate merge step (merge-coverage.ts)
// unions all shards into one lcov.
//
// One shard per GLOBAL, not per process. In a plain run this module is evaluated once per
// process and `__coverage__` accumulates across every file, so the single shard is
// overwritten with an ever-larger map and the last write is complete. Under
// `bun test --parallel`, which implies `--isolate`, each FILE gets a fresh global: this
// module is re-evaluated and `__coverage__` starts empty, so a per-process name would let
// every file overwrite its predecessor and keep only the last one's coverage (measured on
// gateway/src/egress: 619 covered lines serially, 407 with --parallel and a per-pid name).
// The id below is minted at module evaluation, so it is per-process in the first case and
// per-file in the second, and the shard set is complete in both.
import { afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TMP_DIR = resolve(REPO_ROOT, "coverage", ".nyc-tmp");
const SHARD_ID = `${process.pid}-${randomUUID()}`;

afterAll(() => {
  const cov = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__;
  if (cov === undefined || Object.keys(cov).length === 0) return;
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(resolve(TMP_DIR, `${SHARD_ID}.json`), JSON.stringify(cov));
});

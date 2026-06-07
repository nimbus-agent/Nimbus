// Bun [test].preload — after all tests in a `bun test` invocation, dump the raw
// istanbul coverage map to a per-process JSON shard. A separate merge step
// (merge-coverage.ts) unions all shards into one lcov. Per-process file is
// overwrite-idempotent, so this is correct whether afterAll fires once or
// per-file and whether Bun runs one process or many (design spec §5.2.1).
import { afterAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const TMP_DIR = resolve(REPO_ROOT, "coverage", ".nyc-tmp");

afterAll(() => {
  const cov = (globalThis as { __coverage__?: Record<string, unknown> }).__coverage__;
  if (cov === undefined || Object.keys(cov).length === 0) return;
  mkdirSync(TMP_DIR, { recursive: true });
  writeFileSync(resolve(TMP_DIR, `${process.pid}.json`), JSON.stringify(cov));
});

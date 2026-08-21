#!/usr/bin/env bun
/**
 * Pre-bundles every gateway worker entry to JavaScript so it can be embedded in the compiled
 * binary. See `packages/gateway/src/workers/worker-entries.ts` for why this is necessary — in
 * short, `new Worker(new URL("./w.ts", import.meta.url))` resolves at runtime, the bundler never
 * sees it, and both of the gateway's workers were dead in every packaged build as a result.
 *
 * Output goes to `packages/gateway/dist/workers/<name>.js`, which is gitignored, and is embedded
 * by `packages/gateway/src/workers/embedded-workers.ts` with `{ type: "file" }`.
 *
 * `--target bun` keeps `bun:sqlite` and friends external, which is what the worker realm wants;
 * everything else is bundled in, so the emitted file has no relative imports to resolve at load.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_ENTRIES, WORKER_OUT_DIR } from "../packages/gateway/src/workers/worker-entries.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDir = join(repoRoot, "packages", "gateway");
const outDir = join(gatewayDir, ...WORKER_OUT_DIR.split("/"));

function main(): void {
  mkdirSync(outDir, { recursive: true });

  for (const entry of WORKER_ENTRIES) {
    const sourceAbs = join(gatewayDir, ...entry.source.split("/"));
    if (!existsSync(sourceAbs)) {
      process.stderr.write(
        `build-workers: entry not found: ${entry.source}\n` +
          "  `WORKER_ENTRIES` in packages/gateway/src/workers/worker-entries.ts names a file that " +
          "does not exist. Fix the manifest, or restore the worker.\n",
      );
      process.exit(1);
    }
    const outfile = join(outDir, `${entry.name}.js`);
    const r = spawnSync(
      process.execPath,
      ["build", sourceAbs, "--target", "bun", "--outfile", outfile],
      { cwd: gatewayDir, stdio: "inherit", env: process.env },
    );
    if ((r.status ?? 1) !== 0) {
      process.stderr.write(`build-workers: bun build failed for ${entry.source}\n`);
      process.exit(r.status ?? 1);
    }
    process.stdout.write(
      `build-workers: ${entry.source} → ${WORKER_OUT_DIR}/${entry.name}.js ` +
        `(${String(statSync(outfile).size)} bytes)\n`,
    );
  }
}

main();

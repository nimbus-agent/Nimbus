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
 * `target: "bun"` keeps `bun:sqlite` and friends external, which is what the worker realm wants;
 * everything else is bundled in, so the emitted file has no relative imports to resolve at load.
 *
 * Built through `Bun.build()` rather than the `bun build` CLI for one reason: the CLI has no
 * aliasing flag, and the embedding worker needs TWO native modules dealt with: `sharp` replaced
 * with a falsy stub, and the onnxruntime addon embedded so it can be loaded from a real file at
 * runtime. Both otherwise kill the embedding runtime at init (#1396). See
 * `packages/gateway/src/workers/sharp-stub.ts` and `scripts/onnx-binding-plugin.ts`.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WORKER_ENTRIES, WORKER_OUT_DIR } from "../packages/gateway/src/workers/worker-entries.ts";
import { onnxBindingPlugin } from "./onnx-binding-plugin.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayDir = join(repoRoot, "packages", "gateway");
const outDir = join(gatewayDir, ...WORKER_OUT_DIR.split("/"));

/**
 * Replace `sharp` with a falsy stub. `@xenova/transformers` imports it statically for IMAGE
 * preprocessing; it is a NATIVE module, so bundling the real one makes the worker fail at load
 * and takes the entire embedding runtime with it (#1396). This worker does text only, and
 * transformers guards every use with `else if (sharp)` — upstream maps `"sharp": false` in its
 * own browser field for exactly this reason.
 */
const stubSharpPlugin: import("bun").BunPlugin = {
  name: "stub-sharp",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({
      path: join(gatewayDir, "src", "workers", "sharp-stub.ts"),
    }));
  },
};

async function main(): Promise<void> {
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
    const result = await Bun.build({
      entrypoints: [sourceAbs],
      target: "bun",
      outdir: outDir,
      naming: `${entry.name}.js`,
      plugins: [stubSharpPlugin, onnxBindingPlugin],
    });
    if (!result.success) {
      process.stderr.write(`build-workers: bun build failed for ${entry.source}\n`);
      for (const log of result.logs) {
        process.stderr.write(`  ${String(log)}\n`);
      }
      process.exit(1);
    }
    process.stdout.write(
      `build-workers: ${entry.source} → ${WORKER_OUT_DIR}/${entry.name}.js ` +
        `(${String(statSync(outfile).size)} bytes)\n`,
    );
  }
}

await main();

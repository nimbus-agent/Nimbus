#!/usr/bin/env bun
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The onnxruntime native binding, copied next to the bundled embedding worker.
 *
 * Without it semantic search is DEAD — not degraded. `@xenova/transformers` reaches
 * `onnxruntime-node`, whose own code does `require("../bin/napi-v3/<platform>/<arch>/
 * onnxruntime_binding.node")` relative to itself. Once the worker is bundled to
 * `dist/workers/embedding-worker.js` that relative path resolves to `dist/bin/napi-v3/...`, which
 * nothing ever created, so the worker died at init on every install. A real gateway reported
 * `embeddings: "unavailable"` across 397 consecutive heartbeats (#1396).
 *
 * This mirrors `copy-vec0-sidecar.ts`, deliberately — including the lesson recorded there. That
 * copy "previously lived only in `compile-gateway.ts`, which the release pipeline never runs", so
 * released binaries shipped without it and failed silently. Same shape of bug, same remedy: a
 * standalone script both call sites invoke.
 *
 * The destination is NOT beside the executable like `vec0`. It is beside the bundled worker,
 * because the path is computed by third-party code we do not control — we place the file where
 * `onnxruntime-node` already looks rather than teaching it a new location.
 */
export function onnxOsSegment(platform: NodeJS.Platform): string {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}

/** `dist/bin/napi-v3/<platform>/<arch>` — the path the bundled worker's own require computes. */
export function onnxSidecarRelDir(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return join("bin", "napi-v3", onnxOsSegment(platform), arch);
}

const GATEWAY_PACKAGE_JSON = fileURLToPath(
  new URL("../packages/gateway/package.json", import.meta.url),
);

/**
 * `onnxruntime-node` is a TRANSITIVE dependency (via `@xenova/transformers`), so resolution starts
 * from the gateway manifest and hops through the package that actually declares it.
 */
export function resolveOnnxBindingOrThrow(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const rel = `bin/napi-v3/${onnxOsSegment(platform)}/${arch}/onnxruntime_binding.node`;
  try {
    const req = createRequire(GATEWAY_PACKAGE_JSON);
    const transformersIndex = req.resolve("@xenova/transformers");
    const onnxIndex = createRequire(transformersIndex).resolve("onnxruntime-node");
    // `onnxIndex` is `.../onnxruntime-node/dist/index.js`; the binding sits two levels up.
    return join(dirname(dirname(onnxIndex)), ...rel.split("/"));
  } catch (e: unknown) {
    throw new Error(
      `copy-onnx-sidecar: cannot resolve ${rel} for ${platform}/${arch}. ` +
        "Without it the embedding worker dies at init and semantic search is silently disabled. " +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function copyOnnxSidecar(
  workerOutDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const src = resolveOnnxBindingOrThrow(platform, arch);
  // `workerOutDir` is `<gateway>/dist/workers`; the require resolves one level up from there.
  const destDir = join(dirname(workerOutDir), onnxSidecarRelDir(platform, arch));
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, "onnxruntime_binding.node");
  copyFileSync(src, dest);
  return dest;
}

if (import.meta.main) {
  const gatewayDist = fileURLToPath(new URL("../packages/gateway/dist", import.meta.url));
  const out = copyOnnxSidecar(join(gatewayDist, "workers"));
  process.stdout.write(`copy-onnx-sidecar: ${out}\n`);
}

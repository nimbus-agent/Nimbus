#!/usr/bin/env bun
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The sqlite-vec loadable extension, copied beside the gateway binary.
 *
 * `tryLoadFromSidecar()` looks for it at `dirname(process.execPath)`
 * (packages/gateway/src/index/sqlite-vec-load.ts), so the copy has to land in every archive and
 * installer. It previously lived only in `compile-gateway.ts`, which the release pipeline never
 * runs — released binaries shipped without it and semantic memory failed at `log.debug` level,
 * silently. That is why this is a standalone script called from both places.
 */
export function vec0Filename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

export function npmOsSegment(platform: NodeJS.Platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  return "linux";
}

/**
 * `sqlite-vec` is declared by `packages/gateway`, not by the root package, so resolution has to
 * start from the gateway's own manifest. This script used to live inside that package, where a
 * bare `createRequire(import.meta.url)` happened to work; from `scripts/` it does not.
 */
const GATEWAY_PACKAGE_JSON = fileURLToPath(
  new URL("../packages/gateway/package.json", import.meta.url),
);

export function resolveVec0SourceOrThrow(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const pkg = `sqlite-vec-${npmOsSegment(platform)}-${arch}`;
  const fname = vec0Filename(platform);
  try {
    const sqliteVecIndex = createRequire(GATEWAY_PACKAGE_JSON).resolve("sqlite-vec");
    return createRequire(sqliteVecIndex).resolve(`${pkg}/${fname}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `copy-vec0-sidecar: native dep "${pkg}" not found in node_modules (${msg}); ` +
        `bun install may have skipped it on this platform — the resulting gateway binary cannot load semantic memory.`,
    );
  }
}

/** Copy the host platform's sidecar into `destDir`; returns the destination path. */
export function copyVec0Sidecar(destDir: string): string {
  const src = resolveVec0SourceOrThrow();
  mkdirSync(destDir, { recursive: true });
  const dest = join(destDir, vec0Filename(process.platform));
  copyFileSync(src, dest);
  return dest;
}

if (import.meta.main) {
  const flagIndex = process.argv.indexOf("--dest");
  const destArg = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const destDir = resolve(destArg ?? "dist");
  const dest = copyVec0Sidecar(destDir);
  process.stdout.write(`copy-vec0-sidecar: → ${dest} (${String(statSync(dest).size)} bytes)\n`);
}

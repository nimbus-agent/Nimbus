#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { terminateCompiledGatewayBinary } from "./terminate-gateway-binary.ts";

const gatewayPkgDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(gatewayPkgDir, "../..");
const distDir = join(repoRoot, "dist");
const binaryName = process.platform === "win32" ? "nimbus-gateway.exe" : "nimbus-gateway";
const outfileAbs = join(distDir, binaryName);
const prevAbs = `${outfileAbs}.prev`;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function rotateExistingBinaryOrThrow(): void {
  if (existsSync(prevAbs)) {
    try {
      unlinkSync(prevAbs);
    } catch {
      /* previous rotation may still be executing; ignore */
    }
  }
  if (existsSync(outfileAbs)) {
    renameSync(outfileAbs, prevAbs);
  }
}

function npmOsSegment(platform: NodeJS.Platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "darwin";
  return "linux";
}

function vec0Filename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

function resolveVec0SourceOrThrow(): string {
  const pkg = `sqlite-vec-${npmOsSegment(process.platform)}-${process.arch}`;
  const fname = vec0Filename(process.platform);
  try {
    const sqliteVecIndex = createRequire(import.meta.url).resolve("sqlite-vec");
    const reqFromVec = createRequire(sqliteVecIndex);
    return reqFromVec.resolve(`${pkg}/${fname}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `compile-gateway: native dep "${pkg}" not found in node_modules (${msg}); ` +
        `bun install may have skipped it on this platform — the resulting gateway binary cannot load semantic memory.`,
    );
  }
}

function copyVec0Sidecar(): void {
  const src = resolveVec0SourceOrThrow();
  const dest = join(distDir, vec0Filename(process.platform));
  copyFileSync(src, dest);
  const size = statSync(dest).size;
  process.stdout.write(`compile-gateway: copied ${src} → ${dest} (${String(size)} bytes)\n`);
}

async function main(): Promise<void> {
  terminateCompiledGatewayBinary();
  await sleepMs(process.platform === "win32" ? 600 : 200);

  try {
    rotateExistingBinaryOrThrow();
  } catch {
    terminateCompiledGatewayBinary();
    await sleepMs(process.platform === "win32" ? 600 : 200);
    try {
      rotateExistingBinaryOrThrow();
    } catch (e) {
      process.stderr.write(
        "Could not rotate existing gateway binary. Run `bun run kill-gateway` or stop nimbus-gateway, then retry.\n\n",
      );
      throw e;
    }
  }

  const r = spawnSync(
    process.execPath,
    [
      "build",
      "src/index.ts",
      "--target",
      "bun",
      "--compile",
      "--outfile",
      join("..", "..", "dist", "nimbus-gateway"),
    ],
    { cwd: gatewayPkgDir, stdio: "inherit", env: process.env },
  );

  const status = r.status === null ? 1 : r.status;
  if (status !== 0) {
    process.exit(status);
  }
  copyVec0Sidecar();
  process.exit(0);
}

await main();

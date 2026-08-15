#!/usr/bin/env bun
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { vec0Filename } from "./copy-vec0-sidecar.ts";

const isWin = process.platform === "win32";
const ext = isWin ? ".exe" : "";

function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] !== undefined) {
    return process.argv[i + 1];
  }
  return undefined;
}

const repoRoot = resolve(import.meta.dir, "..");
const defaultGateway = join(repoRoot, "dist", `nimbus-gateway${ext}`);
const defaultCli = join(repoRoot, "dist", `nimbus${ext}`);

const outDir = resolve(repoRoot, parseArg("--out") ?? join("dist", "headless-bundle"));
const gatewaySrc = resolve(repoRoot, parseArg("--gateway") ?? defaultGateway);
const cliSrc = resolve(repoRoot, parseArg("--cli") ?? defaultCli);
const embeddingModelDir =
  parseArg("--embedding-model-dir") ?? process.env["NIMBUS_EMBEDDING_MODEL_DIR"];
const skipEmbeddingModel = process.argv.includes("--skip-embedding-model");

for (const [label, p] of [
  ["gateway", gatewaySrc],
  ["cli", cliSrc],
] as const) {
  if (!existsSync(p)) {
    console.error(
      `package-headless-bundle: missing ${label} binary at ${p}\n` +
        `Build gateway and CLI first (see release workflow: bun build … --outfile ../../dist/…).`,
    );
    process.exit(1);
  }
}

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const gwDest = join(outDir, `nimbus-gateway${ext}`);
const cliDest = join(outDir, `nimbus${ext}`);
copyFileSync(gatewaySrc, gwDest);
copyFileSync(cliSrc, cliDest);

// sqlite-vec loadable extension, beside the gateway binary because tryLoadFromSidecar() resolves
// it from dirname(process.execPath). Optional: `bun run --filter @nimbus/gateway build` produces it in dist/, but
// a bundle assembled from pre-built binaries may not have one, and that only costs semantic memory.
const vec0Name = vec0Filename(process.platform);
const vec0Src = resolve(repoRoot, "dist", vec0Name);
if (existsSync(vec0Src)) {
  copyFileSync(vec0Src, join(outDir, vec0Name));
}

async function materializeEmbeddingModelDefault(dest: string): Promise<void> {
  const modelMod = join(repoRoot, "packages/gateway/src/embedding/model.ts");
  const { createLocalEmbedder } = await import(modelMod);
  const embedder = await createLocalEmbedder({ cacheDir: dest });
  await embedder.embed(["nimbus headless bundle embedding warmup"]);
}

try {
  if (embeddingModelDir !== undefined && embeddingModelDir.trim() !== "") {
    const src = resolve(embeddingModelDir.trim());
    if (existsSync(src)) {
      const dest = join(outDir, "embedding-model");
      cpSync(src, dest, { recursive: true });
      console.log(`Embedding weights copied to ${dest}`);
      console.log(
        "Set NIMBUS_EMBEDDING_MODEL_DIR to this directory on the target host (or pass the same path to --embedding-model-dir when packaging).",
      );
    } else {
      console.warn(
        `package-headless-bundle: NIMBUS_EMBEDDING_MODEL_DIR / --embedding-model-dir points to missing path: ${src}`,
      );
    }
  } else if (skipEmbeddingModel) {
    console.warn(
      "package-headless-bundle: --skip-embedding-model set; bundle has no embedding-model/ (set NIMBUS_EMBEDDING_MODEL_DIR on the host or re-package with weights).",
    );
  } else {
    const dest = join(outDir, "embedding-model");
    mkdirSync(dest, { recursive: true });
    console.log("Materializing local embedding model (all-MiniLM-L6-v2) — may download ONNX once…");
    await materializeEmbeddingModelDefault(dest);
    console.log(
      `Embedding weights written to ${dest}. Target hosts: set NIMBUS_EMBEDDING_MODEL_DIR to this directory for offline embedding.`,
    );
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(
    `package-headless-bundle: failed to prepare embedding weights (${msg}). ` +
      `Pre-download weights and pass --embedding-model-dir, or use --skip-embedding-model for a bundle without embeddings.`,
  );
  process.exit(1);
}

console.log(`Headless bundle written to ${outDir}`);
console.log(`  ${gwDest}`);
console.log(`  ${cliDest}`);

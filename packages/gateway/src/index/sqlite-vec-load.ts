import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join, posix as posixPath, win32 as winPath } from "node:path";
import pino from "pino";
import { load as loadSqliteVec } from "sqlite-vec";

const log = pino({
  name: "sqlite-vec-load",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export function tryLoadSqliteVec(db: Database): boolean {
  try {
    loadSqliteVec(db);
    log.debug({ via: "npm" }, "sqlite-vec loaded");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug({ err: msg }, "upstream sqlite-vec load failed; trying sidecar");
    return tryLoadFromSidecar(db);
  }
}

export function loadSqliteVecOrThrow(db: Database): void {
  if (!tryLoadSqliteVec(db)) {
    throw new Error(
      "sqlite-vec could not be loaded. Embeddings require a supported platform (see sqlite-vec npm optionalDependencies).",
    );
  }
}

export function isVecLoaded(db: Database): boolean {
  try {
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export function ensureSqliteVecForConnection(db: Database, indexedUserVersion: number): boolean {
  if (indexedUserVersion < 6) {
    return true;
  }
  try {
    db.query("SELECT vec_version()").get();
    return true;
  } catch {
    return tryLoadSqliteVec(db);
  }
}

export function sidecarFilename(platform: NodeJS.Platform): string {
  if (platform === "win32") return "vec0.dll";
  if (platform === "darwin") return "vec0.dylib";
  return "vec0.so";
}

export function sidecarPath(execPath: string, platform: NodeJS.Platform): string {
  const p = platform === "win32" ? winPath : posixPath;
  return p.join(p.dirname(execPath), sidecarFilename(platform));
}

export function tryLoadFromSidecar(
  db: Database,
  baseDir: string = dirname(process.execPath),
): boolean {
  const path = join(baseDir, sidecarFilename(process.platform));
  if (!existsSync(path)) {
    log.debug({ sidecar: path }, "sqlite-vec sidecar not found; semantic memory disabled");
    return false;
  }
  try {
    db.loadExtension(path);
    log.debug({ via: "sidecar", sidecar: path }, "sqlite-vec loaded");
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug({ sidecar: path, err: msg }, "sqlite-vec sidecar load failed");
    return false;
  }
}

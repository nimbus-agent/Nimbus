import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { holdingDir, prevVersionDir, prevVersionsDir, swapBufferDir } from "./version-store.ts";

function hexEqualIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

export async function verifyTarballSha256(
  bytes: Uint8Array,
  expectedHex: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hexEqualIgnoreCase(hex, expectedHex);
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface DownloadTarballOpts {
  fetcher: FetchFn;
  maxBytes: number;
  signal: AbortSignal;
}

export const MAX_TARBALL_BYTES = 50 * 1024 * 1024;
export async function downloadTarball(url: string, opts: DownloadTarballOpts): Promise<Uint8Array> {
  const res = await opts.fetcher(url, { signal: opts.signal });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`tarball fetch failed: HTTP ${res.status}`);
  }
  const cl = res.headers.get("content-length");
  if (cl !== null) {
    const declared = Number(cl);
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      throw new Error(`tarball too large: content-length=${declared} > ${opts.maxBytes}`);
    }
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > opts.maxBytes) {
    throw new Error(`tarball too large: body=${bytes.byteLength} > ${opts.maxBytes}`);
  }
  return bytes;
}

export interface ApplyUpgradeOpts {
  /** The row's flat `install_path`. */
  installPath: string;
  extensionsDir: string;
  id: string;
  pendingExtractedDir: string;
  fromVersion: string;
  toVersion: string;
}

export interface ApplyDowngradeOpts {
  installPath: string;
  extensionsDir: string;
  id: string;
  fromVersion: string;
  toVersion: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Moves each of `names` from `fromDir` to the same name under `toDir`, best-effort. The renames
 * are independent (distinct names, distinct targets) and each failure is swallowed on its own,
 * so they run together: every one is attempted, and this never rejects.
 */
async function moveEntriesBestEffort(
  names: readonly string[],
  fromDir: string,
  toDir: string,
): Promise<void> {
  await Promise.all(
    names.map((name) => rename(join(fromDir, name), join(toDir, name)).catch(() => {})),
  );
}

async function restoreHolding(holdingPath: string, prevDir: string): Promise<void> {
  if (!(await exists(holdingPath))) return;
  await moveEntriesBestEffort(await readdir(holdingPath), holdingPath, prevDir);
  await rm(holdingPath, { recursive: true, force: true });
}

export async function applyUpgradeSwap(opts: ApplyUpgradeOpts): Promise<void> {
  const prevDir = prevVersionsDir(opts.extensionsDir, opts.id);
  const newPrevPath = prevVersionDir(opts.extensionsDir, opts.id, opts.fromVersion);
  const holdingPath = holdingDir(opts.extensionsDir, opts.id);

  await mkdir(prevDir, { recursive: true });

  // EVERY existing prev entry leaves the way, including prev/<fromVersion>: after an
  // upgrade -> downgrade -> upgrade it can be non-empty and would fail the rename below.
  let movedAside = false;
  const existing = await readdir(prevDir);
  if (existing.length > 0) {
    await mkdir(holdingPath, { recursive: true });
    await moveEntriesBestEffort(existing, prevDir, holdingPath);
    movedAside = true;
  }

  try {
    await rename(opts.installPath, newPrevPath);
  } catch (e) {
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    throw e;
  }

  try {
    await rename(opts.pendingExtractedDir, opts.installPath);
  } catch (e) {
    await rename(newPrevPath, opts.installPath).catch(() => {});
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    throw e;
  }

  await rm(holdingPath, { recursive: true, force: true });
}

export async function applyDowngradeSwap(opts: ApplyDowngradeOpts): Promise<void> {
  const targetPrevPath = prevVersionDir(opts.extensionsDir, opts.id, opts.toVersion);
  const swapPrevPath = prevVersionDir(opts.extensionsDir, opts.id, opts.fromVersion);
  const buffer = swapBufferDir(opts.extensionsDir, opts.id);

  if (!(await exists(targetPrevPath))) {
    throw new Error("downgrade_unavailable");
  }
  await mkdir(prevVersionsDir(opts.extensionsDir, opts.id), { recursive: true });
  await rm(buffer, { recursive: true, force: true });

  await rename(opts.installPath, buffer);

  try {
    await rename(targetPrevPath, opts.installPath);
  } catch (e) {
    await rename(buffer, opts.installPath).catch(() => {});
    throw e;
  }

  try {
    await rename(buffer, swapPrevPath);
  } catch (e) {
    throw new Error(`swap_failed: prev rename: ${e instanceof Error ? e.message : String(e)}`);
  }
}

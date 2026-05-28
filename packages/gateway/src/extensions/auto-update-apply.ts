import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

function hexEqualIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

export async function verifyTarballSha256(
  bytes: Uint8Array,
  expectedHex: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
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
  extRoot: string;
  pendingExtractedDir: string;
  fromVersion: string;
  toVersion: string;
}

export interface ApplyDowngradeOpts {
  extRoot: string;
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

async function restoreHolding(holdingPath: string, prevDir: string): Promise<void> {
  if (!(await exists(holdingPath))) return;
  const entries = await readdir(holdingPath);
  for (const e of entries) {
    await rename(join(holdingPath, e), join(prevDir, e)).catch(() => {});
  }
  await rm(holdingPath, { recursive: true, force: true });
}

export async function applyUpgradeSwap(opts: ApplyUpgradeOpts): Promise<void> {
  const activePath = join(opts.extRoot, "active");
  const prevDir = join(opts.extRoot, "_prev");
  const newPrevPath = join(prevDir, opts.fromVersion);
  const holdingPath = join(opts.extRoot, "_holding");

  await mkdir(prevDir, { recursive: true });

  let movedAside = false;
  const stale = (await readdir(prevDir)).filter((e) => e !== opts.fromVersion);
  if (stale.length > 0) {
    await mkdir(holdingPath, { recursive: true });
    for (const v of stale) {
      await rename(join(prevDir, v), join(holdingPath, v)).catch(() => {});
    }
    movedAside = true;
  }

  try {
    await rename(activePath, newPrevPath);
  } catch (e) {
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    await rm(prevDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  try {
    await rename(opts.pendingExtractedDir, activePath);
  } catch (e) {
    await rename(newPrevPath, activePath).catch(() => {});
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    throw e;
  }

  await rm(holdingPath, { recursive: true, force: true });
}

export async function applyDowngradeSwap(opts: ApplyDowngradeOpts): Promise<void> {
  const activePath = join(opts.extRoot, "active");
  const prevDir = join(opts.extRoot, "_prev");
  const targetPrevPath = join(prevDir, opts.toVersion);
  const swapPrevPath = join(prevDir, opts.fromVersion);
  const buffer = join(opts.extRoot, "_swap-buffer");

  if (!(await exists(targetPrevPath))) {
    throw new Error("downgrade_unavailable");
  }
  await mkdir(prevDir, { recursive: true });

  await rename(activePath, buffer);

  try {
    await rename(targetPrevPath, activePath);
  } catch (e) {
    await rename(buffer, activePath).catch(() => {});
    throw e;
  }

  try {
    await rename(buffer, swapPrevPath);
  } catch (e) {
    throw new Error(`swap_failed: _prev rename: ${e instanceof Error ? e.message : String(e)}`);
  }
}

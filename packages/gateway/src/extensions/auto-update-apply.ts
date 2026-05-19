import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/** Hex-string equality, case-insensitive. NOT constant-time — the hashes are public bytes. */
function hexEqualIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/** Verify the SHA-256 of `bytes` matches `expectedHex` (case-insensitive hex). */
export async function verifyTarballSha256(
  bytes: Uint8Array,
  expectedHex: string,
): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
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

/** Max tarball download bytes. Matches the Gateway updater's MAX_DOWNLOAD_BYTES posture. */
export const MAX_TARBALL_BYTES = 50 * 1024 * 1024; // 50 MiB — generous for an extension

/**
 * Fetch a tarball URL, enforce `maxBytes` against both declared
 * Content-Length and observed body length, return the bytes.
 */
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
  /** Directory at <extensions-root>/<id>/, contains active/ and optionally _prev/. */
  extRoot: string;
  /** Fully-extracted pending dir, typically at <dataDir>/extensions/_pending/<id>-<toVersion>/. */
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

/**
 * Atomic upgrade swap with revert-on-failure.
 *
 *   Pre  : { active/=vOld, _prev/<oldOlder>?/ } + pendingExtractedDir=vNew
 *   Post : { active/=vNew, _prev/<vOld>/ }      + pendingExtractedDir consumed
 *
 * Crash-resilience: any pre-existing _prev/<older>/ (other than the new
 * fromVersion slot) is moved aside into a holding directory before the new
 * _prev/<from>/ is created. On success the holding dir is removed; on
 * failure its contents are restored.
 */
export async function applyUpgradeSwap(opts: ApplyUpgradeOpts): Promise<void> {
  const activePath = join(opts.extRoot, "active");
  const prevDir = join(opts.extRoot, "_prev");
  const newPrevPath = join(prevDir, opts.fromVersion);
  const holdingPath = join(opts.extRoot, "_holding");

  await mkdir(prevDir, { recursive: true });

  // Step 0: if a pre-existing _prev/<older>/ is present, move it aside.
  let movedAside = false;
  const stale = (await readdir(prevDir)).filter((e) => e !== opts.fromVersion);
  if (stale.length > 0) {
    await mkdir(holdingPath, { recursive: true });
    for (const v of stale) {
      await rename(join(prevDir, v), join(holdingPath, v)).catch(() => {});
    }
    movedAside = true;
  }

  // Step 1: active → _prev/<from>
  try {
    await rename(activePath, newPrevPath);
  } catch (e) {
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    // No mutation of active/ on failure — clean up the empty _prev dir if we
    // created it just now to avoid leaving an orphan.
    await rm(prevDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }

  // Step 2: pendingExtractedDir → active
  try {
    await rename(opts.pendingExtractedDir, activePath);
  } catch (e) {
    // Revert step 1.
    await rename(newPrevPath, activePath).catch(() => {});
    if (movedAside) await restoreHolding(holdingPath, prevDir);
    throw e;
  }

  // Success — drop the holding dir (older _prev entries retired).
  await rm(holdingPath, { recursive: true, force: true });
}

/**
 * Atomic downgrade swap.
 *
 *   Pre  : { active/=vNew, _prev/<vOld>/ }
 *   Post : { active/=vOld, _prev/<vNew>/ }
 *
 * Requires _prev/<toVersion>/ to exist; throws `downgrade_unavailable` otherwise.
 */
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

  // Step 1: active → _swap-buffer
  await rename(activePath, buffer);

  try {
    // Step 2: _prev/<to> → active
    await rename(targetPrevPath, activePath);
  } catch (e) {
    // Revert step 1.
    await rename(buffer, activePath).catch(() => {});
    throw e;
  }

  try {
    // Step 3: _swap-buffer → _prev/<from>
    await rename(buffer, swapPrevPath);
  } catch (e) {
    // active/ now holds toVersion — leave it; surface the partial state.
    throw new Error(`swap_failed: _prev rename: ${e instanceof Error ? e.message : String(e)}`);
  }
}

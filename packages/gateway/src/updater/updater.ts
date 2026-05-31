import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import { fetchUpdateManifest, isPermittedSchemeForUpdater } from "./manifest-fetcher.ts";
import { sha256Hex, verifyBinarySignature, verifyManifestEnvelope } from "./signature-verifier.ts";
import type { PlatformTarget, UpdateManifest, UpdaterStatus } from "./types.ts";

const URL_USERINFO_RE = /[a-zA-Z0-9+\-.]{1,32}:\/\/[^\s/@]{1,256}@[^\s/]{1,256}/g;

export function redactUrlUserinfo(message: string): string {
  return message.replaceAll(URL_USERINFO_RE, (urlMatch) => {
    try {
      const u = new URL(urlMatch);
      u.username = "";
      u.password = "";
      return u.toString();
    } catch {
      return "[REDACTED-URL]";
    }
  });
}

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export type UpdaterEmit = (
  name:
    | "updater.updateAvailable"
    | "updater.downloadProgress"
    | "updater.restarting"
    | "updater.rolledBack"
    | "updater.verifyFailed",
  payload?: Record<string, unknown>,
) => void;

export type UpdateEventPhase =
  | "system.update.start"
  | "system.update.verified"
  | "system.update.installed"
  | "system.update.failed";

export interface UpdaterOptions {
  currentVersion: string;
  manifestUrl: string;
  publicKey: Uint8Array;
  target: PlatformTarget;
  emit: UpdaterEmit;
  timeoutMs: number;
  invokeInstaller?: (binaryPath: string) => Promise<void>;
  recordUpdateEvent?: (phase: UpdateEventPhase, payload: Record<string, unknown>) => void;
  maxDownloadBytes?: number;
}

export interface CheckNowResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  notes?: string;
}

export class Updater {
  private state: UpdaterStatus["state"] = "idle";
  private lastManifest?: UpdateManifest;
  private lastError?: string;
  private lastCheckAt?: string;

  constructor(private readonly opts: UpdaterOptions) {}

  async checkNow(): Promise<CheckNowResult> {
    this.state = "checking";
    try {
      const manifest = await fetchUpdateManifest(this.opts.manifestUrl, {
        timeoutMs: this.opts.timeoutMs,
      });
      this.lastManifest = manifest;
      this.lastCheckAt = new Date().toISOString();
      const updateAvailable = semverGreater(manifest.version, this.opts.currentVersion);
      if (updateAvailable) {
        const payload: Record<string, unknown> = { version: manifest.version };
        if (manifest.notes !== undefined) {
          payload["notes"] = manifest.notes;
        }
        this.opts.emit("updater.updateAvailable", payload);
      }
      this.state = "idle";
      const result: CheckNowResult = {
        currentVersion: this.opts.currentVersion,
        latestVersion: manifest.version,
        updateAvailable,
      };
      if (manifest.notes !== undefined) {
        result.notes = manifest.notes;
      }
      return result;
    } catch (err) {
      this.state = "failed";
      this.lastError = redactUrlUserinfo(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  async applyUpdate(): Promise<void> {
    const { manifest, asset } = this.requireApplyPreconditions();
    this.opts.recordUpdateEvent?.("system.update.start", {
      fromVersion: this.opts.currentVersion,
      toVersion: manifest.version,
      manifestUrl: this.opts.manifestUrl,
      sha256: asset.sha256,
      target: this.opts.target,
    });
    const bytes = await this.downloadOrFail(asset.url, manifest.version);
    this.verifyOrFail(bytes, asset, manifest.version);
    await this.installOrFail(bytes, manifest.version);
  }

  private requireApplyPreconditions(): {
    manifest: UpdateManifest;
    asset: { url: string; sha256: string; signature: string };
  } {
    if (!this.lastManifest) {
      throw new Error("no manifest loaded — call checkNow() first");
    }
    if (!semverGreater(this.lastManifest.version, this.opts.currentVersion)) {
      throw new Error(
        `Manifest version ${this.lastManifest.version} is not newer than ` +
          `current version ${this.opts.currentVersion}; aborting download`,
      );
    }
    const asset = this.lastManifest.platforms[this.opts.target];
    if (!asset) {
      throw new Error(`no asset for target ${this.opts.target}`);
    }
    return { manifest: this.lastManifest, asset };
  }

  private async downloadOrFail(url: string, toVersion: string): Promise<Uint8Array> {
    this.state = "downloading";
    try {
      return await this.downloadAsset(url);
    } catch (err) {
      this.state = "failed";
      this.lastError = err instanceof Error ? err.message : String(err);
      this.opts.emit("updater.rolledBack", { reason: "download_failed" });
      this.opts.recordUpdateEvent?.("system.update.failed", {
        toVersion,
        reason: "download_failed",
      });
      throw err;
    }
  }

  private verifyOrFail(
    bytes: Uint8Array,
    asset: { sha256: string; signature: string },
    toVersion: string,
  ): void {
    this.state = "verifying";
    const computedSha = sha256Hex(bytes);
    if (!sha256HexEqualConstantTime(computedSha, asset.sha256)) {
      this.failVerification(toVersion, "hash_mismatch");
      throw new Error(`binary hash mismatch: expected ${asset.sha256}, got ${computedSha}`);
    }
    const sigBytes = new Uint8Array(Buffer.from(asset.signature, "base64"));
    const envelopeOk = verifyManifestEnvelope({
      version: toVersion,
      target: this.opts.target,
      sha256: asset.sha256,
      signature: sigBytes,
      publicKey: this.opts.publicKey,
    });
    if (envelopeOk) {
      this.opts.recordUpdateEvent?.("system.update.verified", { toVersion, envelope: true });
      return;
    }
    if (!verifyBinarySignature(bytes, sigBytes, this.opts.publicKey)) {
      this.failVerification(toVersion, "signature_invalid");
      throw new Error("Ed25519 signature verification failed");
    }
    this.opts.recordUpdateEvent?.("system.update.verified", { toVersion, envelope: false });
  }

  private failVerification(toVersion: string, reason: "hash_mismatch" | "signature_invalid"): void {
    this.state = "rolled_back";
    this.opts.emit("updater.verifyFailed", { reason });
    this.opts.emit("updater.rolledBack", { reason });
    this.opts.recordUpdateEvent?.("system.update.failed", { toVersion, reason });
  }

  private async installOrFail(bytes: Uint8Array, toVersion: string): Promise<void> {
    this.state = "applying";
    const { dir, path: binaryPath } = await writeToTempFile(bytes);
    try {
      if (this.opts.invokeInstaller) {
        await this.opts.invokeInstaller(binaryPath);
      }
      this.opts.recordUpdateEvent?.("system.update.installed", {
        fromVersion: this.opts.currentVersion,
        toVersion,
      });
      this.opts.emit("updater.restarting", {
        fromVersion: this.opts.currentVersion,
        toVersion,
      });
      this.state = "idle";
    } catch (err) {
      this.state = "failed";
      this.lastError = redactUrlUserinfo(err instanceof Error ? err.message : String(err));
      this.opts.emit("updater.rolledBack", { reason: "installer_failed" });
      this.opts.recordUpdateEvent?.("system.update.failed", {
        toVersion,
        reason: "installer_failed",
      });
      throw err;
    } finally {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  private async downloadAsset(url: string): Promise<Uint8Array> {
    if (!isPermittedSchemeForUpdater(url)) {
      let scheme: string;
      try {
        scheme = new URL(url).protocol;
      } catch {
        scheme = url;
      }
      throw new Error(`asset URL must be https:// (got ${scheme})`);
    }
    const cap = this.opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`download HTTP ${resp.status}`);
    const declaredTotal = Number(resp.headers.get("content-length") ?? 0);
    if (declaredTotal > cap) {
      throw new Error(`Content-Length ${declaredTotal} exceeds download size cap of ${cap} bytes`);
    }
    const reader = resp.body?.getReader();
    if (reader === undefined) throw new Error("No response body from download");
    const chunks: Uint8Array[] = [];
    let downloaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        downloaded += value.byteLength;
        if (downloaded > cap) {
          await reader.cancel();
          throw new Error(`Download body exceeds size cap of ${cap} bytes (read ${downloaded})`);
        }
        chunks.push(value);
        this.opts.emit("updater.downloadProgress", { bytes: downloaded, total: declaredTotal });
      }
    }
    const bytes = new Uint8Array(downloaded);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return bytes;
  }

  getStatus(): UpdaterStatus {
    const status: UpdaterStatus = {
      state: this.state,
      currentVersion: this.opts.currentVersion,
      configUrl: this.opts.manifestUrl,
    };
    if (this.lastCheckAt !== undefined) {
      status.lastCheckAt = this.lastCheckAt;
    }
    if (this.lastError !== undefined) {
      status.lastError = this.lastError;
    }
    return status;
  }
}

function semverGreater(a: string, b: string): boolean {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

async function writeToTempFile(bytes: Uint8Array): Promise<{ dir: string; path: string }> {
  const { chmodSync, mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "nimbus-update-"));
  const path = join(dir, "installer.bin");
  writeFileSync(path, bytes, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* belt-and-suspenders for filesystems that ignore the create-mode */
  }
  return { dir, path };
}

export { ManifestFetchError } from "./manifest-fetcher.ts";

import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { PlatformPaths } from "../platform/paths.ts";
import { addressAsPointer } from "./ffi-ptr.ts";
import {
  compareVaultKeysAlphabetically,
  isWellFormedVaultKey,
  validateVaultKeyOrThrow,
} from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

const crypt32 = dlopen("crypt32.dll", {
  CryptProtectData: {
    args: [
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
    ],
    returns: FFIType.uint32_t,
  },
  CryptUnprotectData: {
    args: [
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
    ],
    returns: FFIType.uint32_t,
  },
});

const kernel32 = dlopen("kernel32.dll", {
  LocalFree: {
    args: [FFIType.pointer],
    returns: FFIType.pointer,
  },
});

const DATA_BLOB_LAYOUT_BYTES = 16;
const ENTROPY_FILENAME = ".entropy";
const ENTROPY_LEN = 32;

function writeDataBlob(target: Buffer, cbData: number, pbDataPtr: bigint): void {
  target.writeUInt32LE(cbData, 0);
  target.writeBigUInt64LE(pbDataPtr, 8);
}

function readPbDataPtr(blob: Buffer): bigint {
  return blob.readBigUInt64LE(8);
}

function readCbData(blob: Buffer): number {
  return blob.readUInt32LE(0);
}

function pointerToBigInt(p: unknown): bigint {
  if (typeof p === "bigint") {
    return p;
  }
  if (typeof p === "number") {
    return BigInt(p);
  }
  throw new Error("Unexpected pointer type from FFI");
}

function bufferFromPointer(addr: bigint, byteLength: number): Buffer {
  const src = new Uint8Array(toArrayBuffer(addressAsPointer(addr), 0, byteLength));
  return Buffer.from(src.slice());
}

function loadOrCreateEntropy(vaultDir: string): Buffer {
  const path = join(vaultDir, ENTROPY_FILENAME);
  try {
    const buf = readFileSync(path);
    if (buf.length === ENTROPY_LEN) return buf;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw err;
    }
  }

  mkdirSync(vaultDir, { recursive: true });
  const generated = randomBytes(ENTROPY_LEN);
  try {
    writeFileSync(path, generated, { mode: 0o600, flag: "wx" });
    if (process.platform === "win32") {
      try {
        const winDir = process.env["SystemRoot"] ?? process.env["windir"] ?? String.raw`C:\Windows`;
        const attribExe = String.raw`${winDir}\System32\attrib.exe`;
        spawnSync(attribExe, ["+H", "+S", path], { windowsHide: true });
      } catch {
        /* best effort — entropy still works without the attribute */
      }
    }
    return generated;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      const buf = readFileSync(path);
      if (buf.length === ENTROPY_LEN) return buf;
    }
    throw err;
  }
}

function dpapiEncrypt(plain: Buffer, entropy: Buffer | null): Buffer {
  const inBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
  const plainPtr = ptr(plain);
  writeDataBlob(inBlob, plain.length, pointerToBigInt(plainPtr));

  let entropyArg: ReturnType<typeof ptr> | null = null;
  let entropyBlob: Buffer | undefined;
  if (entropy !== null && entropy.length > 0) {
    entropyBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
    const entropyPtr = ptr(entropy);
    writeDataBlob(entropyBlob, entropy.length, pointerToBigInt(entropyPtr));
    entropyArg = ptr(entropyBlob);
  }

  const outBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
  outBlob.fill(0);

  const ok = crypt32.symbols.CryptProtectData(
    ptr(inBlob),
    null,
    entropyArg,
    null,
    null,
    0,
    ptr(outBlob),
  );
  if (ok === 0) {
    throw new Error("Vault encryption failed");
  }

  const outLen = readCbData(outBlob);
  const outPb = readPbDataPtr(outBlob);
  try {
    return bufferFromPointer(outPb, outLen);
  } finally {
    kernel32.symbols.LocalFree(addressAsPointer(outPb));
  }
}

function dpapiDecrypt(encrypted: Buffer, entropy: Buffer | null): Buffer | null {
  const inBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
  const encPtr = ptr(encrypted);
  writeDataBlob(inBlob, encrypted.length, pointerToBigInt(encPtr));

  let entropyArg: ReturnType<typeof ptr> | null = null;
  let entropyBlob: Buffer | undefined;
  if (entropy !== null && entropy.length > 0) {
    entropyBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
    const entropyPtr = ptr(entropy);
    writeDataBlob(entropyBlob, entropy.length, pointerToBigInt(entropyPtr));
    entropyArg = ptr(entropyBlob);
  }

  const outBlob = Buffer.alloc(DATA_BLOB_LAYOUT_BYTES);
  outBlob.fill(0);

  const ok = crypt32.symbols.CryptUnprotectData(
    ptr(inBlob),
    null,
    entropyArg,
    null,
    null,
    0,
    ptr(outBlob),
  );
  if (ok === 0) return null;

  const outLen = readCbData(outBlob);
  const outPb = readPbDataPtr(outBlob);
  try {
    return bufferFromPointer(outPb, outLen);
  } finally {
    kernel32.symbols.LocalFree(addressAsPointer(outPb));
  }
}

export function _legacyEncryptForTest(plaintext: string): Buffer {
  return dpapiEncrypt(Buffer.from(plaintext, "utf8"), null);
}

export class DpapiVault implements NimbusVault {
  private readonly vaultDir: string;
  private cachedEntropy: Buffer | undefined;

  constructor(paths: PlatformPaths) {
    this.vaultDir = join(paths.configDir, "vault");
  }

  private getEntropy(): Buffer {
    if (this.cachedEntropy === undefined) {
      this.cachedEntropy = loadOrCreateEntropy(this.vaultDir);
    }
    return this.cachedEntropy;
  }

  private encPath(key: string): string {
    return join(this.vaultDir, `${key}.enc`);
  }

  async set(key: string, value: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    await mkdir(this.vaultDir, { recursive: true });
    const entropy = this.getEntropy();
    const encrypted = dpapiEncrypt(Buffer.from(value, "utf8"), entropy);

    const b64 = encrypted.toString("base64");
    const finalPath = this.encPath(key);
    const tag = `${process.pid}.${randomBytes(8).toString("hex")}`;
    const tmpPath = `${finalPath}.tmp.${tag}`;
    const handle = await open(tmpPath, "w", 0o600);
    try {
      await handle.writeFile(b64, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmpPath, finalPath);
    } catch (err) {
      try {
        await unlink(tmpPath);
      } catch {
        /* best effort */
      }
      throw err;
    }

    await this.sweepStaleTempFiles(key);
  }

  private async sweepStaleTempFiles(key: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.vaultDir);
    } catch {
      return;
    }
    const prefix = `${key}.enc.tmp.`;
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const full = join(this.vaultDir, entry);
      try {
        await unlink(full);
      } catch {
        /* ignore */
      }
    }
  }

  async get(key: string): Promise<string | null> {
    validateVaultKeyOrThrow(key);
    const path = this.encPath(key);
    let b64: string;
    try {
      b64 = await readFile(path, "utf8");
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        return null;
      }
      throw err;
    }
    let encrypted: Buffer;
    try {
      encrypted = Buffer.from(b64, "base64");
    } catch {
      throw new Error("Vault read failed");
    }

    const entropy = this.getEntropy();
    const withEntropy = dpapiDecrypt(encrypted, entropy);
    if (withEntropy !== null) {
      return withEntropy.toString("utf8");
    }
    const legacy = dpapiDecrypt(encrypted, null);
    if (legacy === null) {
      throw new Error("Vault decryption failed");
    }
    const plaintext = legacy.toString("utf8");
    try {
      await this.set(key, plaintext);
    } catch {
      /* best effort — return the recovered value even if re-encrypt fails */
    }
    return plaintext;
  }

  async delete(key: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    try {
      await unlink(this.encPath(key));
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  async listKeys(prefix?: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.vaultDir);
    } catch (err: unknown) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT") {
        return [];
      }
      throw err;
    }
    const keys = names
      .filter((n) => n.endsWith(".enc"))
      .map((n) => n.slice(0, -".enc".length))
      .filter((k) => isWellFormedVaultKey(k))
      .sort(compareVaultKeysAlphabetically);
    if (prefix === undefined || prefix.length === 0) {
      return keys;
    }
    return keys.filter((k) => k.startsWith(prefix));
  }
}

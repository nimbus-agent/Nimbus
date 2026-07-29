import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { PlatformPaths } from "../platform/paths.ts";
import {
  describeKeychainFailure,
  ERR_SEC_ITEM_NOT_FOUND,
  ERR_SEC_SUCCESS,
  type KeychainOp,
} from "./darwin-keychain-status.ts";
import { addressAsPointer } from "./ffi-ptr.ts";
import { compareVaultKeysAlphabetically, validateVaultKeyOrThrow } from "./key-format.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

const SERVICE = "dev.nimbus";

const security = dlopen("/System/Library/Frameworks/Security.framework/Security", {
  /**
   * Turns the keychain's GUI authorization dialog OFF for this process.
   *
   * `Boolean` in Apple's headers is a 1-byte `unsigned char`, so `u8` (0/1) is
   * declared rather than a bool whose FFI width would be less obvious.
   */
  SecKeychainSetUserInteractionAllowed: {
    args: [FFIType.u8],
    returns: FFIType.int32_t,
  },
  SecKeychainAddGenericPassword: {
    args: [
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
      FFIType.pointer,
    ],
    returns: FFIType.int32_t,
  },
  SecKeychainFindGenericPassword: {
    args: [
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
      FFIType.uint32_t,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
      FFIType.pointer,
    ],
    returns: FFIType.int32_t,
  },
  SecKeychainItemDelete: {
    args: [FFIType.pointer],
    returns: FFIType.int32_t,
  },
  SecKeychainItemFreeContent: {
    args: [FFIType.pointer, FFIType.pointer],
    returns: FFIType.int32_t,
  },
});

const coreFoundation = dlopen(
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
  {
    CFRelease: {
      args: [FFIType.pointer],
      returns: FFIType.void,
    },
  },
);

/**
 * Refuse the keychain UI for the whole gateway process.
 *
 * WHY THIS IS LOAD-BEARING. `SecKeychainAddGenericPassword` against a locked
 * default keychain escalates to a GUI authorization prompt:
 *
 *   SecKeychainAddGenericPassword -> StorageManager::defaultKeychainUI
 *     -> makeLoginAuthUI -> AuthorizationCopyRights
 *       -> xpc_connection_send_message_with_reply_SYNC -> mach_msg  [blocks]
 *
 * With no GUI session nobody can answer that dialog, and the XPC round-trip is
 * synchronous, so the call never returns. Because every symbol here is a
 * *synchronous* `bun:ffi` call on the main thread, the blocked call also freezes
 * the event loop: no timer fires, nothing logs, and the IPC socket is never
 * bound. `nimbus init` hung forever with no diagnostic at all (issue #932).
 *
 * That also rules out the obvious-looking fix: you cannot wrap a synchronous FFI
 * call in a `Promise.race` timeout, because the timer can never run. The block
 * has to be prevented, not bounded — so interaction is disabled up front and a
 * locked keychain returns `errSecInteractionNotAllowed` immediately instead.
 *
 * A background daemon has no business presenting a modal dialog in any case, and
 * this brings macOS into line with Linux, which already fails fast on a locked
 * keyring rather than waiting on a prompt.
 */
function denyKeychainUserInteraction(): void {
  // Best-effort: if this ever fails we are no worse off than before the fix, and
  // failing startup over it would be a worse outcome than the risk it removes.
  try {
    security.symbols.SecKeychainSetUserInteractionAllowed(0);
  } catch {
    /* best-effort */
  }
}

denyKeychainUserInteraction();

export class DarwinKeychainVault implements NimbusVault {
  private readonly vaultDir: string;
  private readonly indexPath: string;

  constructor(paths: PlatformPaths) {
    this.vaultDir = join(paths.configDir, "vault");
    this.indexPath = join(this.vaultDir, ".keyindex.json");
    // The process-wide setting is applied at module load; re-asserting it per
    // instance costs nothing and keeps the guarantee true if anything in the
    // process re-enabled interaction behind our back.
    denyKeychainUserInteraction();
  }

  private async readIndex(): Promise<string[]> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      const keys: string[] = [];
      for (const x of parsed) {
        if (typeof x === "string") {
          keys.push(x);
        }
      }
      return keys.sort(compareVaultKeysAlphabetically);
    } catch {
      return [];
    }
  }

  private async writeIndex(keys: string[]): Promise<void> {
    const unique = [...new Set(keys)].sort(compareVaultKeysAlphabetically);
    await mkdir(this.vaultDir, { recursive: true });
    await writeFile(this.indexPath, `${JSON.stringify(unique)}\n`, "utf8");
  }

  private async removeFromIndex(key: string): Promise<void> {
    const keys = await this.readIndex();
    await this.writeIndex(keys.filter((k) => k !== key));
  }

  private async addToIndex(key: string): Promise<void> {
    const keys = await this.readIndex();
    if (!keys.includes(key)) {
      keys.push(key);
    }
    await this.writeIndex(keys);
  }

  private freePasswordDataIfPresent(pwdLen: number, pwdPtr: bigint): void {
    if (pwdLen > 0 && pwdPtr !== 0n) {
      security.symbols.SecKeychainItemFreeContent(null, addressAsPointer(pwdPtr));
    }
  }

  private deleteKeychainItemAndRelease(itemRef: bigint, op: KeychainOp): void {
    if (itemRef === 0n) {
      return;
    }
    const delStatus = security.symbols.SecKeychainItemDelete(addressAsPointer(itemRef));
    if (delStatus !== ERR_SEC_SUCCESS) {
      throw new Error(describeKeychainFailure(op, delStatus));
    }
    coreFoundation.symbols.CFRelease(addressAsPointer(itemRef));
  }

  private bestEffortReleaseItemRef(itemRef: bigint): void {
    if (itemRef === 0n) {
      return;
    }
    try {
      coreFoundation.symbols.CFRelease(addressAsPointer(itemRef));
    } catch {
      /* best-effort */
    }
  }

  private readPlainPasswordFromKeychainPointer(pwdLen: number, pwdPtr: bigint): string {
    if (pwdLen === 0 || pwdPtr === 0n) {
      return "";
    }
    return Buffer.from(toArrayBuffer(addressAsPointer(pwdPtr), 0, pwdLen)).toString("utf8");
  }

  private serviceAndKeyBuffers(key: string): { svcBuf: Buffer; keyBuf: Buffer } {
    return { svcBuf: Buffer.from(SERVICE), keyBuf: Buffer.from(key, "utf8") };
  }

  private keychainFindGenericPassword(key: string): {
    status: number;
    passwordLengthBuf: Buffer;
    passwordDataOutBuf: Buffer;
    itemRefBuf: Buffer;
  } {
    const { svcBuf, keyBuf } = this.serviceAndKeyBuffers(key);
    const passwordLengthBuf = Buffer.alloc(4);
    const passwordDataOutBuf = Buffer.alloc(8);
    const itemRefBuf = Buffer.alloc(8);
    passwordDataOutBuf.fill(0);
    itemRefBuf.fill(0);

    const status = security.symbols.SecKeychainFindGenericPassword(
      null,
      svcBuf.length,
      ptr(svcBuf),
      keyBuf.length,
      ptr(keyBuf),
      ptr(passwordLengthBuf),
      ptr(passwordDataOutBuf),
      ptr(itemRefBuf),
    );

    return { status, passwordLengthBuf, passwordDataOutBuf, itemRefBuf };
  }

  private releaseFindGenericPasswordOutputs(pwdPtr: bigint, itemRef: bigint): void {
    if (pwdPtr !== 0n) {
      security.symbols.SecKeychainItemFreeContent(null, addressAsPointer(pwdPtr));
    }
    if (itemRef !== 0n) {
      coreFoundation.symbols.CFRelease(addressAsPointer(itemRef));
    }
  }

  private bestEffortReleaseFindGenericPasswordOutputs(pwdPtr: bigint, itemRef: bigint): void {
    if (pwdPtr !== 0n) {
      try {
        security.symbols.SecKeychainItemFreeContent(null, addressAsPointer(pwdPtr));
      } catch {
        /* best-effort */
      }
    }
    if (itemRef !== 0n) {
      try {
        coreFoundation.symbols.CFRelease(addressAsPointer(itemRef));
      } catch {
        /* best-effort */
      }
    }
  }

  private isSecItemNotFoundStatus(status: number): boolean {
    return status === ERR_SEC_ITEM_NOT_FOUND;
  }

  private throwIfDeleteLookupFailed(status: number, op: KeychainOp): void {
    if (status !== ERR_SEC_SUCCESS) {
      throw new Error(describeKeychainFailure(op, status));
    }
  }

  private performKeychainDeleteAfterSuccessfulLookup(
    pwdLen: number,
    pwdPtr: bigint,
    itemRef: bigint,
    op: KeychainOp,
  ): void {
    try {
      this.freePasswordDataIfPresent(pwdLen, pwdPtr);
      this.deleteKeychainItemAndRelease(itemRef, op);
    } catch (err) {
      this.bestEffortReleaseItemRef(itemRef);
      throw err;
    }
  }

  /**
   * `op` is the caller's operation, not necessarily "delete": `set()` clears any
   * existing item first, so a keychain that refuses this lookup must report the
   * failure as a failed *store*. Reporting "delete failed" during `nimbus init`
   * would send a stuck user looking in the wrong place.
   */
  private async deleteKeychainOnly(key: string, op: KeychainOp): Promise<void> {
    const { status, passwordLengthBuf, passwordDataOutBuf, itemRefBuf } =
      this.keychainFindGenericPassword(key);

    if (this.isSecItemNotFoundStatus(status)) {
      return;
    }
    this.throwIfDeleteLookupFailed(status, op);

    const pwdLen = passwordLengthBuf.readUInt32LE(0);
    const pwdPtr = passwordDataOutBuf.readBigUInt64LE(0);
    const itemRef = itemRefBuf.readBigUInt64LE(0);
    this.performKeychainDeleteAfterSuccessfulLookup(pwdLen, pwdPtr, itemRef, op);
  }

  async set(key: string, value: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    await this.deleteKeychainOnly(key, "store");

    const { svcBuf, keyBuf } = this.serviceAndKeyBuffers(key);
    const pass = Buffer.from(value, "utf8");
    const status = security.symbols.SecKeychainAddGenericPassword(
      null,
      svcBuf.length,
      ptr(svcBuf),
      keyBuf.length,
      ptr(keyBuf),
      pass.length,
      ptr(pass),
      null,
    );
    if (status !== ERR_SEC_SUCCESS) {
      throw new Error(describeKeychainFailure("store", status));
    }
    await this.addToIndex(key);
  }

  async get(key: string): Promise<string | null> {
    validateVaultKeyOrThrow(key);
    const { status, passwordLengthBuf, passwordDataOutBuf, itemRefBuf } =
      this.keychainFindGenericPassword(key);

    if (status === ERR_SEC_ITEM_NOT_FOUND) {
      return null;
    }
    if (status !== ERR_SEC_SUCCESS) {
      throw new Error(describeKeychainFailure("read", status));
    }

    const pwdLen = passwordLengthBuf.readUInt32LE(0);
    const pwdPtr = passwordDataOutBuf.readBigUInt64LE(0);
    const itemRef = itemRefBuf.readBigUInt64LE(0);

    let plain: string;
    try {
      plain = this.readPlainPasswordFromKeychainPointer(pwdLen, pwdPtr);
      this.releaseFindGenericPasswordOutputs(pwdPtr, itemRef);
    } catch (err) {
      this.bestEffortReleaseFindGenericPasswordOutputs(pwdPtr, itemRef);
      throw err;
    }

    return plain;
  }

  async delete(key: string): Promise<void> {
    validateVaultKeyOrThrow(key);
    await this.deleteKeychainOnly(key, "delete");
    await this.removeFromIndex(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = await this.readIndex();
    if (prefix === undefined || prefix.length === 0) {
      return keys;
    }
    return keys.filter((k) => k.startsWith(prefix));
  }
}

/**
 * The Windows connection source: which TCP connections belong to ONE extension's AppContainer.
 *
 * Every pass reads the machine's TCP table (`GetExtendedTcpTable`, IPv4 and IPv6, with the owning
 * PID) and keeps the rows whose owning process's token carries the AppContainer SID that the
 * sandbox helper derives from the extension's profile name. The SID covers the extension's whole
 * process tree, grandchildren included, and no unrelated process: an unsandboxed process connecting
 * to the same host has no AppContainer SID at all. Spike 6a proved this unelevated on Windows 11 and
 * on the windows-latest runner.
 *
 * Runs only inside the `__nimbus-sandbox` wrapper process, never in the gateway. Observation only:
 * nothing here decides what the child may reach.
 */

import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { dotted, formatIpv6, portFromDword } from "./address.ts";
import type { ConnectionSource, ObservedConnection } from "./types.ts";

// --- Win32 constants -----------------------------------------------------------------------------

const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_ALL = 5;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
const MIB_TCP_STATE_LISTEN = 2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
/** TOKEN_INFORMATION_CLASS.TokenAppContainerSid. */
const TOKEN_APP_CONTAINER_SID = 31;

// --- Row layouts (as in spike 6a's poll-win32.c) -------------------------------------------------
//
// Both tables are `DWORD dwNumEntries` followed by the rows; every field is 4-byte aligned, so the
// first row starts at offset 4. Ports are DWORDs holding the port in NETWORK byte order in their low
// 16 bits; IPv4 addresses are DWORDs in network byte order (so the bytes in memory read a.b.c.d).

const TABLE_HEADER_BYTES = 4;

/** MIB_TCPROW_OWNER_PID: dwState, dwLocalAddr, dwLocalPort, dwRemoteAddr, dwRemotePort, dwOwningPid. */
const V4_ROW = {
  bytes: 24,
  state: 0,
  localPort: 8,
  remoteAddr: 12,
  remotePort: 16,
  pid: 20,
} as const;

/**
 * MIB_TCP6ROW_OWNER_PID: ucLocalAddr[16], dwLocalScopeId, dwLocalPort, ucRemoteAddr[16],
 * dwRemoteScopeId, dwRemotePort, dwState, dwOwningPid (16+4+4+16+4+4+4+4 = 56 bytes).
 */
const V6_ROW = {
  bytes: 56,
  localPort: 20,
  remoteAddr: 24,
  remotePort: 44,
  state: 48,
  pid: 52,
} as const;

/** Where the first table read starts; grown (and kept) when the table does not fit. */
const INITIAL_TABLE_BYTES = 64 * 1024;
/** The table can grow between the size query and the read, so a busy machine may need a retry. */
const TABLE_READ_ATTEMPTS = 4;
/** TOKEN_APPCONTAINER_INFORMATION is one PSID followed by the SID it points at (at most 68 bytes). */
const TOKEN_INFO_BYTES = 512;

// --- Libraries -----------------------------------------------------------------------------------

function openLibraries(open: typeof dlopen) {
  const opened: { close(): void }[] = [];
  const track = <T extends { close(): void }>(lib: T): T => {
    opened.push(lib);
    return lib;
  };
  try {
    const iphlpapi = track(
      open("iphlpapi.dll", {
        // (pTcpTable, pdwSize, bOrder, ulAf, TableClass, Reserved) -> DWORD
        GetExtendedTcpTable: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.i32, FFIType.u32],
          returns: FFIType.u32,
        },
      }),
    );
    const userenv = track(
      open("userenv.dll", {
        // (PCWSTR pszAppContainerName, PSID *ppsidAppContainerSid) -> HRESULT
        DeriveAppContainerSidFromAppContainerName: {
          args: [FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
      }),
    );
    const advapi32 = track(
      open("advapi32.dll", {
        // (HANDLE ProcessHandle, DWORD DesiredAccess, PHANDLE TokenHandle) -> BOOL
        OpenProcessToken: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
        // (HANDLE, TOKEN_INFORMATION_CLASS, LPVOID, DWORD, PDWORD ReturnLength) -> BOOL
        GetTokenInformation: {
          args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
          returns: FFIType.i32,
        },
        // (PSID, PSID) -> BOOL
        EqualSid: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        // (PSID) -> PVOID (NULL on success). The SID Derive... returns is freed with FreeSid.
        FreeSid: { args: [FFIType.ptr], returns: FFIType.ptr },
      }),
    );
    const kernel32 = track(
      open("kernel32.dll", {
        // (DWORD dwDesiredAccess, BOOL bInheritHandle, DWORD dwProcessId) -> HANDLE (NULL on failure)
        OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
        // (HANDLE, LPFILETIME creation, exit, kernel, user) -> BOOL
        GetProcessTimes: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        // (HANDLE) -> BOOL
        CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      }),
    );
    return { iphlpapi, userenv, advapi32, kernel32, opened };
  } catch (e) {
    closeAll(opened);
    throw e;
  }
}

type Libraries = ReturnType<typeof openLibraries>;
/** A process handle as bun:ffi returns it from OpenProcess (NULL already ruled out). */
type ProcessHandle = NonNullable<ReturnType<Libraries["kernel32"]["symbols"]["OpenProcess"]>>;

function closeAll(libs: readonly { close(): void }[]): void {
  for (const lib of libs) {
    try {
      lib.close();
    } catch {
      // Closing a library that is going away anyway: nothing useful to do with a failure.
    }
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A pointer-sized value read out of a buffer the OS wrote. User-mode addresses fit in 2^53. */
function readPointer(buf: Buffer, offset: number): Pointer | null {
  const v = Number(buf.readBigUInt64LE(offset));
  return v === 0 ? null : (v as Pointer);
}

// --- Address decoding ----------------------------------------------------------------------------

function isZero(buf: Buffer, offset: number, len: number): boolean {
  for (let i = 0; i < len; i++) if (buf[offset + i] !== 0) return false;
  return true;
}

/** One row as the table holds it, before attribution. */
type RawRow = { pid: number; localPort: number; remoteIp: string; remotePort: number };

/** Every connected row of one table: listeners, rows with no remote address and PID 0 left out. */
function decodeRows(buf: Buffer, af: number): RawRow[] {
  const v4 = af === AF_INET;
  const layout = v4 ? V4_ROW : V6_ROW;
  const addrLen = v4 ? 4 : 16;
  // Never trust the count past the end of what was written.
  const count = Math.min(
    buf.readUInt32LE(0),
    Math.floor((buf.length - TABLE_HEADER_BYTES) / layout.bytes),
  );
  const rows: RawRow[] = [];
  for (let i = 0; i < count; i++) {
    const o = TABLE_HEADER_BYTES + i * layout.bytes;
    const pid = buf.readUInt32LE(o + layout.pid);
    // PID 0 owns TIME_WAIT rows: a connection already closed, owned by no process.
    if (pid === 0 || buf.readUInt32LE(o + layout.state) === MIB_TCP_STATE_LISTEN) continue;
    if (isZero(buf, o + layout.remoteAddr, addrLen)) continue;
    rows.push({
      pid,
      localPort: portFromDword(buf.readUInt32LE(o + layout.localPort)),
      remoteIp: v4 ? dotted(buf, o + layout.remoteAddr) : formatIpv6(buf, o + layout.remoteAddr),
      remotePort: portFromDword(buf.readUInt32LE(o + layout.remotePort)),
    });
  }
  return rows;
}

// --- The source ----------------------------------------------------------------------------------

type Verdict = { creation: bigint; match: boolean };

export function openWin32ConnectionSource(opts: {
  profileName: string;
  dlopen?: typeof dlopen;
}): ConnectionSource | { error: string } {
  let libs: Libraries;
  try {
    libs = openLibraries(opts.dlopen ?? dlopen);
  } catch (e) {
    return { error: `cannot load the Windows connection-table libraries: ${message(e)}` };
  }
  const sid = deriveSid(libs, opts.profileName);
  if ("error" in sid) {
    closeAll(libs.opened);
    return sid;
  }
  return new Win32ConnectionSource(libs, sid.sid);
}

function deriveSid(libs: Libraries, profileName: string): { sid: Pointer } | { error: string } {
  // PCWSTR: UTF-16LE, NUL-terminated. Kept alive only for the call; the API copies what it needs.
  const name = Buffer.from(`${profileName}\0`, "utf16le");
  const out = Buffer.alloc(8);
  try {
    const hr = libs.userenv.symbols.DeriveAppContainerSidFromAppContainerName(ptr(name), ptr(out));
    const sid = readPointer(out, 0);
    if (hr !== 0 || sid === null) {
      return {
        error: `DeriveAppContainerSidFromAppContainerName failed for ${profileName}: 0x${(hr >>> 0).toString(16)}`,
      };
    }
    return { sid };
  } catch (e) {
    return { error: `DeriveAppContainerSidFromAppContainerName threw: ${message(e)}` };
  }
}

class Win32ConnectionSource implements ConnectionSource {
  /** One growing buffer per address family, kept across polls. */
  private readonly tables = new Map<number, Buffer>([
    [AF_INET, Buffer.alloc(INITIAL_TABLE_BYTES)],
    [AF_INET6, Buffer.alloc(INITIAL_TABLE_BYTES)],
  ]);
  private readonly size = new Uint32Array(1);
  /** FILETIME creation, exit, kernel, user: 4 x 8 bytes. */
  private readonly times = Buffer.alloc(32);
  private readonly tokenOut = Buffer.alloc(8);
  private readonly tokenInfo = Buffer.alloc(TOKEN_INFO_BYTES);
  private readonly returnLength = new Uint32Array(1);
  /** The match decision per PID, valid only for the process with that creation time. */
  private readonly verdicts = new Map<number, Verdict>();
  private closed = false;

  constructor(
    private readonly libs: Libraries,
    /** The derived container SID, held for the source's life and released with FreeSid. */
    private readonly sid: Pointer,
  ) {}

  poll(): ObservedConnection[] {
    if (this.closed) throw new Error("the Windows connection source is closed");
    const rows = [
      ...decodeRows(this.readTable(AF_INET), AF_INET),
      ...decodeRows(this.readTable(AF_INET6), AF_INET6),
    ];
    const thisPass = new Map<number, boolean>();
    const out: ObservedConnection[] = [];
    for (const row of rows) {
      let match = thisPass.get(row.pid);
      if (match === undefined) {
        match = this.judge(row.pid);
        thisPass.set(row.pid, match);
      }
      if (match) out.push(row);
    }
    // A PID gone from the table may come back as another process: forget it, so it is judged again.
    for (const pid of this.verdicts.keys()) if (!thisPass.has(pid)) this.verdicts.delete(pid);
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.libs.advapi32.symbols.FreeSid(this.sid);
    } catch {
      // The process is about to stop observing; a failed free cannot be acted on.
    }
    closeAll(this.libs.opened);
  }

  /** The table for one family, in a buffer grown until it fits. Throws when it cannot be read. */
  private readTable(af: number): Buffer {
    let buf = this.tables.get(af) ?? Buffer.alloc(INITIAL_TABLE_BYTES);
    for (let attempt = 0; attempt < TABLE_READ_ATTEMPTS; attempt++) {
      this.size[0] = buf.length;
      const rc = this.libs.iphlpapi.symbols.GetExtendedTcpTable(
        ptr(buf),
        ptr(this.size),
        0,
        af,
        TCP_TABLE_OWNER_PID_ALL,
        0,
      );
      if (rc === NO_ERROR) return buf;
      if (rc !== ERROR_INSUFFICIENT_BUFFER) {
        throw new Error(`GetExtendedTcpTable(af=${af}) failed: ${rc}`);
      }
      // Headroom: the table can grow again before the next call.
      buf = Buffer.alloc(Math.max(this.size[0] ?? 0, buf.length) * 2);
      this.tables.set(af, buf);
    }
    throw new Error(`GetExtendedTcpTable(af=${af}) kept growing past ${buf.length} bytes`);
  }

  /** Whether the process with this PID runs in the observed AppContainer. */
  private judge(pid: number): boolean {
    const k = this.libs.kernel32.symbols;
    // The table was read before this open: a PID that exited and was reused in between is judged as
    // the new process, so within one pass a reused PID can be misattributed (a stated bound).
    const proc = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    // Not openable (protected, or already gone): not attributed, and not cached, so a later pass
    // tries again.
    if (proc === null) return false;
    try {
      const t = this.times;
      if (k.GetProcessTimes(proc, ptr(t, 0), ptr(t, 8), ptr(t, 16), ptr(t, 24)) === 0) return false;
      const creation = t.readBigUInt64LE(0);
      const known = this.verdicts.get(pid);
      if (known !== undefined && known.creation === creation) return known.match;
      const match = this.tokenInContainer(proc);
      if (match === null) return false;
      this.verdicts.set(pid, { creation, match });
      return match;
    } finally {
      k.CloseHandle(proc);
    }
  }

  /** true/false from the token's AppContainer SID; null when the token cannot be read. */
  private tokenInContainer(proc: ProcessHandle): boolean | null {
    const a = this.libs.advapi32.symbols;
    if (a.OpenProcessToken(proc, TOKEN_QUERY, ptr(this.tokenOut)) === 0) return null;
    const token = readPointer(this.tokenOut, 0);
    if (token === null) return null;
    try {
      const info = this.tokenInfo;
      const ok = a.GetTokenInformation(
        token,
        TOKEN_APP_CONTAINER_SID,
        ptr(info),
        info.length,
        ptr(this.returnLength),
      );
      if (ok === 0) return null;
      // TOKEN_APPCONTAINER_INFORMATION.TokenAppContainer: NULL for a process outside any container.
      const tokenSid = readPointer(info, 0);
      return tokenSid !== null && a.EqualSid(this.sid, tokenSid) !== 0;
    } finally {
      this.libs.kernel32.symbols.CloseHandle(token);
    }
  }
}

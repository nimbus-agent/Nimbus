/**
 * The macOS connection source: which TCP connections belong to ONE extension's process tree.
 *
 * `sandbox-exec` execs the child in place, so the PID the runner spawned IS the sandboxed child,
 * and every process it starts inherits the profile. Every pass lists the machine's PIDs, reads each
 * one's parent PID, walks the tree down from that root, and reads the TCP sockets each process in it
 * holds (libproc: `proc_listpids`, `proc_pidinfo`, `proc_pidfdinfo`). An unrelated process
 * connecting to the same host is not in the tree, so it is never attributed. Spike 6a proved an
 * unelevated parent can read a sandboxed child's sockets this way on the macOS runner.
 *
 * Runs only inside the `__nimbus-sandbox` wrapper process, never in the gateway. Observation only:
 * nothing here decides what the child may reach.
 *
 * What it cannot see: a process that leaves the tree (a daemon that double-forks is re-parented to
 * launchd), and a connection that opens and closes between two passes.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ConnectionSource, ObservedConnection } from "./types.ts";
import { formatIpv6, portFromDword } from "./win32-connections.ts";

// --- libproc ABI ---------------------------------------------------------------------------------
//
// Every size, offset and constant below except `PROC_ALL_PIDS` was printed from the macOS SDK on the
// CI runner by spike 6a's `offsets-darwin.c`, run 41614991421 (macos-26-arm64; the x86_64 values are
// identical). `PROC_ALL_PIDS` is `sys/proc_info.h`'s value for "every process".
//
// `proc_listpids` is called rather than `proc_listallpids` because its return value is unambiguous:
// the number of BYTES it wrote. (`proc_listallpids` is a libproc wrapper over the same call that
// divides that by `sizeof(int)` and returns a COUNT, so which unit a caller gets depends on which of
// the two it named. Calling the primitive and dividing by 4 here is right whichever reading of the
// wrapper is correct.)

const LIBPROC = {
  /** proc_listpids type: every process. */
  PROC_ALL_PIDS: 1,
  /** proc_pidinfo flavors. */
  PROC_PIDLISTFDS: 1,
  PROC_PIDTBSDINFO: 3,
  /** proc_pidfdinfo flavor. */
  PROC_PIDFDSOCKETINFO: 3,

  /** struct proc_fdinfo { int32_t proc_fd; uint32_t proc_fdtype; } = PROC_PIDLISTFD_SIZE. */
  FDINFO_BYTES: 8,
  FDINFO_FD: 0,
  FDINFO_TYPE: 4,
  PROX_FDTYPE_SOCKET: 2,

  /** struct proc_bsdinfo, and its `pbi_ppid` (uint32). */
  BSDINFO_BYTES: 136,
  PBI_PPID: 16,

  /** struct socket_fdinfo, and the fields of `psi` this reads. */
  SOCKET_FDINFO_BYTES: 792,
  /** psi.soi_kind (int). */
  SOI_KIND: 256,
  SOCKINFO_TCP: 2,
  /** psi.soi_proto.pri_tcp.tcpsi_ini (struct in_sockinfo) fields. */
  /** insi_fport / insi_lport: int, the port in network byte order in its low 16 bits. */
  INSI_FPORT: 264,
  INSI_LPORT: 268,
  /** insi_vflag (u_char): INI_IPV4 | INI_IPV6. */
  INSI_VFLAG: 288,
  INI_IPV4: 1,
  INI_IPV6: 2,
  /** insi_faddr: a 16-byte union; IPv6 is all 16, IPv4 is `in4in6_addr.i46a_addr4` at +12. */
  INSI_FADDR: 296,
  INSI_FADDR_V4: 308,
} as const;

/** Where the PID and fd buffers start; each is doubled (and kept) while a call fills it. */
const INITIAL_PIDS = 4096;
const INITIAL_FDS = 256;
/** 4096 PIDs doubled 10 times is 4M PIDs; 256 fds doubled 10 times is 256K fds. */
const GROW_ATTEMPTS = 10;

/** libproc's own image first; libSystem re-exports the same symbols. */
const LIBRARY_PATHS = ["/usr/lib/libproc.dylib", "/usr/lib/libSystem.B.dylib"] as const;

const SYMBOLS = {
  // (uint32_t type, uint32_t typeinfo, void *buffer, int buffersize) -> int: bytes written, or -1.
  proc_listpids: {
    args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  // (int pid, int flavor, uint64_t arg, void *buffer, int buffersize) -> int: bytes written, or <= 0.
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  // (int pid, int fd, int flavor, void *buffer, int buffersize) -> int: bytes written, or <= 0.
  proc_pidfdinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
} as const;

function openLibrary(open: typeof dlopen) {
  const errors: string[] = [];
  for (const path of LIBRARY_PATHS) {
    try {
      return open(path, SYMBOLS);
    } catch (e) {
      errors.push(`${path}: ${message(e)}`);
    }
  }
  throw new Error(errors.join("; "));
}

type Library = ReturnType<typeof openLibrary>;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- Decoding ------------------------------------------------------------------------------------

function isZero(buf: Buffer, offset: number, len: number): boolean {
  for (let i = 0; i < len; i++) if (buf[offset + i] !== 0) return false;
  return true;
}

/** The remote address of a TCP socket's `in_sockinfo`, or null when it has none it can name. */
function remoteAddress(buf: Buffer): string | null {
  const vflag = buf[LIBPROC.INSI_VFLAG] ?? 0;
  if ((vflag & LIBPROC.INI_IPV4) !== 0) {
    const o = LIBPROC.INSI_FADDR_V4;
    if (isZero(buf, o, 4)) return null;
    return `${buf[o]}.${buf[o + 1]}.${buf[o + 2]}.${buf[o + 3]}`;
  }
  if ((vflag & LIBPROC.INI_IPV6) !== 0) {
    if (isZero(buf, LIBPROC.INSI_FADDR, 16)) return null;
    return formatIpv6(buf, LIBPROC.INSI_FADDR);
  }
  return null;
}

/** A connected TCP socket's ports and remote, from a whole `socket_fdinfo`; null for anything else. */
function decodeSocket(buf: Buffer): Omit<ObservedConnection, "pid"> | null {
  if (buf.readInt32LE(LIBPROC.SOI_KIND) !== LIBPROC.SOCKINFO_TCP) return null;
  const remotePort = portFromDword(buf.readUInt32LE(LIBPROC.INSI_FPORT));
  // A listener (or a socket not yet connected) has no remote port.
  if (remotePort === 0) return null;
  const remoteIp = remoteAddress(buf);
  if (remoteIp === null) return null;
  return { localPort: portFromDword(buf.readUInt32LE(LIBPROC.INSI_LPORT)), remoteIp, remotePort };
}

/** Every PID reachable from `root` through `children`, root first; a cycle is visited once. */
function descendants(root: number, children: ReadonlyMap<number, readonly number[]>): number[] {
  const tree = [root];
  const seen = new Set(tree);
  for (let i = 0; i < tree.length; i++) {
    for (const kid of children.get(tree[i] ?? 0) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      tree.push(kid);
    }
  }
  return tree;
}

// --- The source ----------------------------------------------------------------------------------

export function openDarwinConnectionSource(opts: {
  rootPid: number;
  dlopen?: typeof dlopen;
}): ConnectionSource | { error: string } {
  if (!Number.isInteger(opts.rootPid) || opts.rootPid <= 0) {
    return { error: `the root PID must be a positive integer, not ${opts.rootPid}` };
  }
  try {
    return new DarwinConnectionSource(openLibrary(opts.dlopen ?? dlopen), opts.rootPid);
  } catch (e) {
    return { error: `cannot load libproc: ${message(e)}` };
  }
}

class DarwinConnectionSource implements ConnectionSource {
  /** Grown (and kept) while proc_listpids fills it. */
  private pids = Buffer.alloc(INITIAL_PIDS * 4);
  /** Grown (and kept) while PROC_PIDLISTFDS fills it. */
  private fds = Buffer.alloc(INITIAL_FDS * LIBPROC.FDINFO_BYTES);
  private readonly bsd = Buffer.alloc(LIBPROC.BSDINFO_BYTES);
  private readonly socket = Buffer.alloc(LIBPROC.SOCKET_FDINFO_BYTES);
  private closed = false;

  constructor(
    private readonly lib: Library,
    private readonly rootPid: number,
  ) {}

  poll(): ObservedConnection[] {
    if (this.closed) throw new Error("the macOS connection source is closed");
    const children = new Map<number, number[]>();
    for (const pid of this.listPids()) {
      const ppid = this.parentOf(pid);
      if (ppid === null) continue;
      const kids = children.get(ppid);
      if (kids === undefined) children.set(ppid, [pid]);
      else kids.push(pid);
    }
    const out: ObservedConnection[] = [];
    for (const pid of descendants(this.rootPid, children)) {
      for (const fd of this.socketFds(pid)) {
        const conn = this.tcpConnection(pid, fd);
        if (conn !== null) out.push({ pid, ...conn });
      }
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.lib.close();
    } catch {
      // Closing a library that is going away anyway: nothing useful to do with a failure.
    }
  }

  /** Every PID on the machine, PID 0 left out. Throws when the list cannot be read. */
  private listPids(): number[] {
    const sym = this.lib.symbols.proc_listpids;
    for (let attempt = 0; attempt < GROW_ATTEMPTS; attempt++) {
      const buf = this.pids;
      const bytes = sym(LIBPROC.PROC_ALL_PIDS, 0, ptr(buf), buf.length);
      if (bytes <= 0) throw new Error(`proc_listpids failed: ${bytes}`);
      if (bytes < buf.length) {
        // BYTES written: four per PID. Nothing past them is this pass's.
        const out: number[] = [];
        for (let o = 0; o + 4 <= bytes; o += 4) {
          const pid = buf.readInt32LE(o);
          if (pid > 0) out.push(pid);
        }
        return out;
      }
      // A full buffer may be a truncated list.
      this.pids = Buffer.alloc(buf.length * 2);
    }
    throw new Error(`proc_listpids kept filling ${this.pids.length} bytes`);
  }

  /** The parent PID, or null when the process cannot be read (another user's, or gone). */
  private parentOf(pid: number): number | null {
    const b = this.bsd;
    const n = this.lib.symbols.proc_pidinfo(pid, LIBPROC.PROC_PIDTBSDINFO, 0, ptr(b), b.length);
    return n === LIBPROC.BSDINFO_BYTES ? b.readUInt32LE(LIBPROC.PBI_PPID) : null;
  }

  /** The process's socket fds; none when its fd list cannot be read. */
  private socketFds(pid: number): number[] {
    const sym = this.lib.symbols.proc_pidinfo;
    let bytes = 0;
    for (let attempt = 1; ; attempt++) {
      bytes = sym(pid, LIBPROC.PROC_PIDLISTFDS, 0, ptr(this.fds), this.fds.length);
      if (bytes <= 0) return [];
      // After the last attempt a still-full buffer is read as it stands: every fd in it is real.
      if (bytes < this.fds.length || attempt === GROW_ATTEMPTS) break;
      this.fds = Buffer.alloc(this.fds.length * 2);
    }
    const buf = this.fds;
    const end = Math.min(bytes, buf.length);
    const out: number[] = [];
    for (let o = 0; o + LIBPROC.FDINFO_BYTES <= end; o += LIBPROC.FDINFO_BYTES) {
      if (buf.readUInt32LE(o + LIBPROC.FDINFO_TYPE) === LIBPROC.PROX_FDTYPE_SOCKET) {
        out.push(buf.readInt32LE(o + LIBPROC.FDINFO_FD));
      }
    }
    return out;
  }

  /** The fd's TCP connection, or null (not TCP, not connected, or not readable in full). */
  private tcpConnection(pid: number, fd: number): Omit<ObservedConnection, "pid"> | null {
    const b = this.socket;
    const n = this.lib.symbols.proc_pidfdinfo(
      pid,
      fd,
      LIBPROC.PROC_PIDFDSOCKETINFO,
      ptr(b),
      b.length,
    );
    return n === LIBPROC.SOCKET_FDINFO_BYTES ? decodeSocket(b) : null;
  }
}

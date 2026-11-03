/**
 * The macOS connection source.
 *
 * The first half drives `openDarwinConnectionSource` on ANY host through its `dlopen` seam: the fake
 * below stands in for libproc and answers through the very pointers the source passes, the way the
 * kernel does (a PID list, `proc_bsdinfo`, a `proc_fdinfo` array and a `socket_fdinfo` written into
 * the caller's buffer, and the byte count returned). Every struct is built from the offsets the
 * spike printed from the macOS SDK on the runner (run 41614991421), written out HERE a second time
 * rather than imported, so a typo in the source's constants block cannot agree with itself.
 *
 * The second half is the real thing on macOS: a child started through the real sandbox runner
 * (`sandbox-exec`) opens connections to a declared host and starts a `curl` grandchild, while an
 * unsandboxed control process does the same; the source must find the child's and the grandchild's
 * and none of the control's.
 */

import { type dlopen, FFIType, type Pointer, toArrayBuffer } from "bun:ffi";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDarwinConnectionSource } from "./darwin-connections.ts";

// ---------------------------------------------------------------------------------------------
// The SDK layout, independently of the source (spike artifact of run 41614991421)
// ---------------------------------------------------------------------------------------------

const PROC_ALL_PIDS = 1;
const PROC_PIDLISTFDS = 1;
const PROC_PIDTBSDINFO = 3;
const PROC_PIDFDSOCKETINFO = 3;
const FDINFO_BYTES = 8;
const PROX_FDTYPE_VNODE = 1;
const PROX_FDTYPE_SOCKET = 2;
const BSDINFO_BYTES = 136;
const PBI_PPID = 16;
const SOCKET_FDINFO_BYTES = 792;
const SOI_KIND = 256;
const SOCKINFO_IN = 1;
const SOCKINFO_TCP = 2;
const SOCKINFO_UN = 3;
const INSI_FPORT = 264;
const INSI_LPORT = 268;
const INSI_VFLAG = 288;
const INSI_FADDR = 296;
const INSI_FADDR_V4 = 308;
const INI_IPV4 = 1;
const INI_IPV6 = 2;

// ---------------------------------------------------------------------------------------------
// Fake libproc
// ---------------------------------------------------------------------------------------------

type FakeSocket = {
  kind: number;
  lport: number;
  rport: number;
  /** A dotted quad (INI_IPV4) or a full 16-byte IPv6 address as 8 hex groups (INI_IPV6). */
  remote: string;
  /** Defaults from `remote`: IPv4 when it has dots. */
  vflag?: number;
};

type FakeFd = { fd: number; type: number; socket?: FakeSocket };

type FakeProc = {
  ppid: number;
  fds?: FakeFd[];
  /** false: PROC_PIDTBSDINFO fails (another user's process, or already gone). */
  bsdReadable?: boolean;
  /** false: PROC_PIDLISTFDS fails (EPERM, or already gone). */
  fdsReadable?: boolean;
  /** true: PROC_PIDFDSOCKETINFO writes fewer bytes than the struct. */
  socketShort?: boolean;
};

interface FakeState {
  procs: Map<number, FakeProc>;
  /** The listing order (defaults to the map's order). */
  listing?: number[];
  /** What proc_listpids returns instead of a byte count. */
  listRc?: number;
  /**
   * PIDs the fake leaves in the caller's buffer PAST the ones it reports, the way a reused buffer
   * holds the previous pass's PIDs. Reading past the returned byte count finds them.
   */
  stale?: number[];
  missing?: readonly string[];
}

interface Rec {
  opened: string[];
  closed: string[];
  decls: Record<string, unknown>[];
  listSizes: number[];
  bsdCalls: number[];
  fdListCalls: number[];
  fdListSizes: number[];
  socketCalls: string[];
  nonSocketQueried: string[];
}

function newRec(): Rec {
  return {
    opened: [],
    closed: [],
    decls: [],
    listSizes: [],
    bsdCalls: [],
    fdListCalls: [],
    fdListSizes: [],
    socketCalls: [],
    nonSocketQueried: [],
  };
}

function view(p: Pointer | number, len: number): Buffer {
  return Buffer.from(toArrayBuffer(p as Pointer, 0, len));
}

function netPort(port: number): number {
  // Network byte order in the low 16 bits of an int.
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

function v4Bytes(addr: string): number[] {
  return addr.split(".").map(Number);
}

function v6Bytes(addr: string): number[] {
  const groups = addr.split(":");
  if (groups.length !== 8) throw new Error(`fake wants 8 IPv6 groups: ${addr}`);
  return groups.flatMap((g) => {
    const n = Number.parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function writeSocket(buf: Buffer, s: FakeSocket): void {
  // Junk everywhere the source must not read, so a wrong offset reads garbage, not a lucky zero.
  buf.fill(0xcd);
  buf.writeInt32LE(s.kind, SOI_KIND);
  buf.writeUInt32LE(netPort(s.rport), INSI_FPORT);
  buf.writeUInt32LE(netPort(s.lport), INSI_LPORT);
  const v4 = s.remote.includes(".");
  buf[INSI_VFLAG] = s.vflag ?? (v4 ? INI_IPV4 : INI_IPV6);
  if (v4) {
    // struct in4in6_addr: three pad words, then the IPv4 address.
    buf.fill(0, INSI_FADDR, INSI_FADDR_V4);
    Buffer.from(v4Bytes(s.remote)).copy(buf, INSI_FADDR_V4);
  } else {
    Buffer.from(v6Bytes(s.remote)).copy(buf, INSI_FADDR);
  }
}

function listPids(s: FakeState, rec: Rec, type: number, info: number, buf: number, size: number) {
  if (type !== PROC_ALL_PIDS || info !== 0) throw new Error(`proc_listpids(${type}, ${info})`);
  rec.listSizes.push(size);
  if (s.listRc !== undefined) return s.listRc;
  const pids = s.listing ?? [...s.procs.keys()];
  const cap = Math.floor(size / 4);
  const n = Math.min(pids.length, cap);
  const out = new Int32Array(toArrayBuffer(buf as Pointer, 0, cap * 4));
  for (let i = 0; i < n; i++) out[i] = pids[i] ?? 0;
  const stale = s.stale ?? [];
  for (let i = 0; i < stale.length && n + i < cap; i++) out[n + i] = stale[i] ?? 0;
  // Bytes, not a count: what proc_listpids returns.
  return n * 4;
}

function bsdInfo(p: FakeProc | undefined, buf: number, size: number): number {
  if (size !== BSDINFO_BYTES) throw new Error(`PROC_PIDTBSDINFO with ${size} bytes`);
  if (p === undefined || p.bsdReadable === false) return 0;
  const b = view(buf, size);
  b.fill(0xab);
  b.writeUInt32LE(p.ppid, PBI_PPID);
  return BSDINFO_BYTES;
}

function listFds(p: FakeProc | undefined, buf: number, size: number): number {
  if (p === undefined || p.fdsReadable === false) return 0;
  const fds = p.fds ?? [];
  const n = Math.min(fds.length, Math.floor(size / FDINFO_BYTES));
  const b = view(buf, size);
  for (let i = 0; i < n; i++) {
    const f = fds[i];
    if (f === undefined) continue;
    b.writeInt32LE(f.fd, i * FDINFO_BYTES);
    b.writeUInt32LE(f.type, i * FDINFO_BYTES + 4);
  }
  return n * FDINFO_BYTES;
}

function pidInfo(s: FakeState, rec: Rec, pid: number, flavor: number, buf: number, size: number) {
  const p = s.procs.get(pid);
  if (flavor === PROC_PIDTBSDINFO) {
    rec.bsdCalls.push(pid);
    return bsdInfo(p, buf, size);
  }
  if (flavor === PROC_PIDLISTFDS) {
    rec.fdListCalls.push(pid);
    rec.fdListSizes.push(size);
    return listFds(p, buf, size);
  }
  throw new Error(`unexpected proc_pidinfo flavor ${flavor}`);
}

function pidFdInfo(
  s: FakeState,
  rec: Rec,
  pid: number,
  fd: number,
  flavor: number,
  buf: number,
  size: number,
) {
  if (flavor !== PROC_PIDFDSOCKETINFO || size !== SOCKET_FDINFO_BYTES) {
    throw new Error(`proc_pidfdinfo flavor ${flavor} with ${size} bytes`);
  }
  rec.socketCalls.push(`${pid}/${fd}`);
  const p = s.procs.get(pid);
  const f = p?.fds?.find((x) => x.fd === fd);
  if (p === undefined || f === undefined) return 0;
  if (f.type !== PROX_FDTYPE_SOCKET || f.socket === undefined) {
    rec.nonSocketQueried.push(`${pid}/${fd}`);
    return 0;
  }
  const b = view(buf, size);
  writeSocket(b, f.socket);
  return p.socketShort === true ? 400 : SOCKET_FDINFO_BYTES;
}

function fakeOpen(s: FakeState, rec: Rec): typeof dlopen {
  const open = (path: string, decl: Record<string, unknown>) => {
    if (s.missing?.includes(path) === true) throw new Error(`${path}: image not found`);
    rec.opened.push(path);
    rec.decls.push(decl);
    const all: Record<string, unknown> = {
      proc_listpids: (t: number, i: number, b: number, z: number) => listPids(s, rec, t, i, b, z),
      proc_pidinfo: (pid: number, f: number, arg: number | bigint, b: number, z: number) => {
        if (BigInt(arg) !== 0n) throw new Error(`proc_pidinfo arg ${arg}`);
        return pidInfo(s, rec, pid, f, b, z);
      },
      proc_pidfdinfo: (pid: number, fd: number, f: number, b: number, z: number) =>
        pidFdInfo(s, rec, pid, fd, f, b, z),
    };
    const symbols: Record<string, unknown> = {};
    for (const sym of Object.keys(decl)) {
      if (!(sym in all)) throw new Error(`${path} has no symbol ${sym}`);
      symbols[sym] = all[sym];
    }
    return { symbols, close: () => rec.closed.push(path) };
  };
  return open as unknown as typeof dlopen;
}

const ROOT = 500;

const tcp = (fd: number, lport: number, remote: string, rport = 443): FakeFd => ({
  fd,
  type: PROX_FDTYPE_SOCKET,
  socket: { kind: SOCKINFO_TCP, lport, rport, remote },
});

function openOk(s: FakeState, rec: Rec, rootPid = ROOT) {
  const src = openDarwinConnectionSource({ rootPid, dlopen: fakeOpen(s, rec) });
  if ("error" in src) throw new Error(`open failed: ${src.error}`);
  return src;
}

const byPort = (a: { localPort: number }, b: { localPort: number }) => a.localPort - b.localPort;

// ---------------------------------------------------------------------------------------------
// Unit tests (any host)
// ---------------------------------------------------------------------------------------------

describe("openDarwinConnectionSource (fake libproc)", () => {
  test("proc_listpids returns BYTES: 12 bytes is 3 PIDs, and nothing past them is read", () => {
    const rec = newRec();
    const s = state([
      [ROOT, { ppid: 1, fds: [tcp(3, 50001, "140.82.112.5")] }],
      [501, { ppid: ROOT, fds: [tcp(4, 50002, "140.82.112.6")] }],
      [1, { ppid: 0 }],
      // A descendant with a connection that is NOT in this pass's listing: only stale buffer
      // contents name it. Reading 12 entries instead of 3 would find it.
      [777, { ppid: ROOT, fds: [tcp(5, 50099, "6.6.6.6")] }],
    ]);
    s.listing = [ROOT, 501, 1];
    s.stale = [777, 777, 777, 777, 777, 777, 777, 777, 777];
    const src = openOk(s, rec);
    expect(src.poll().sort(byPort)).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
      { pid: 501, localPort: 50002, remoteIp: "140.82.112.6", remotePort: 443 },
    ]);
    expect(rec.bsdCalls).not.toContain(777);
    expect(rec.fdListCalls).not.toContain(777);
    src.close();
  });

  test("finds descendants through two levels and nothing outside the tree", () => {
    const rec = newRec();
    const s = state([
      [1, { ppid: 0 }],
      // Listed before its parent: the tree must not depend on listing order.
      [620, { ppid: 610, fds: [tcp(3, 50003, "1.1.1.3")] }],
      [ROOT, { ppid: 400, fds: [tcp(3, 50001, "1.1.1.1")] }],
      [610, { ppid: ROOT, fds: [tcp(7, 50002, "1.1.1.2")] }],
      // The root's parent and a sibling of the root: not descendants.
      [400, { ppid: 1, fds: [tcp(3, 50010, "9.9.9.1")] }],
      [700, { ppid: 400, fds: [tcp(3, 50011, "9.9.9.2")] }],
      // A child of an unrelated process.
      [710, { ppid: 700, fds: [tcp(3, 50012, "9.9.9.3")] }],
    ]);
    const src = openOk(s, rec);
    expect(src.poll().sort(byPort)).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "1.1.1.1", remotePort: 443 },
      { pid: 610, localPort: 50002, remoteIp: "1.1.1.2", remotePort: 443 },
      { pid: 620, localPort: 50003, remoteIp: "1.1.1.3", remotePort: 443 },
    ]);
    // Only the tree's fds are listed.
    expect([...rec.fdListCalls].sort((a, b) => a - b)).toEqual([ROOT, 610, 620]);
    src.close();
  });

  test("a parent-PID cycle outside or inside the tree does not loop", () => {
    const rec = newRec();
    const s = state([
      [ROOT, { ppid: 600, fds: [tcp(3, 50001, "1.1.1.1")] }],
      // 600 claims ROOT as its parent while ROOT claims 600: a stale snapshot can say this.
      [600, { ppid: ROOT, fds: [tcp(3, 50002, "1.1.1.2")] }],
      [800, { ppid: 801 }],
      [801, { ppid: 800 }],
      [0, { ppid: 0 }],
    ]);
    const src = openOk(s, rec);
    expect(src.poll().sort(byPort)).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "1.1.1.1", remotePort: 443 },
      { pid: 600, localPort: 50002, remoteIp: "1.1.1.2", remotePort: 443 },
    ]);
    // PID 0 is never asked about.
    expect(rec.bsdCalls).not.toContain(0);
    expect(rec.fdListCalls.filter((p) => p === ROOT)).toHaveLength(1);
    src.close();
  });

  test("decodes IPv4 and IPv6 remotes and both ports", () => {
    const rec = newRec();
    const s = state([
      [
        ROOT,
        {
          ppid: 1,
          fds: [
            tcp(3, 50001, "140.82.112.5", 443),
            tcp(4, 50002, "2606:50c0:8000:0:0:0:0:154", 8443),
            tcp(5, 65535, "2001:db8:0:0:1:0:0:1", 1),
            tcp(6, 1, "0:0:0:0:0:ffff:8c52:7006", 443),
            tcp(7, 258, "255.0.1.2", 513),
          ],
        },
      ],
    ]);
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
      { pid: ROOT, localPort: 50002, remoteIp: "2606:50c0:8000::154", remotePort: 8443 },
      // RFC 5952: the FIRST of two equal zero runs is the one compressed.
      { pid: ROOT, localPort: 65535, remoteIp: "2001:db8::1:0:0:1", remotePort: 1 },
      // A v6 socket's IPv4-mapped remote, as Node prints one.
      { pid: ROOT, localPort: 1, remoteIp: "::ffff:140.82.112.6", remotePort: 443 },
      // 258 = 0x0102 and 513 = 0x0201: a byte-order mistake swaps these.
      { pid: ROOT, localPort: 258, remoteIp: "255.0.1.2", remotePort: 513 },
    ]);
    src.close();
  });

  test("skips non-socket fds without asking for socket info, and non-TCP sockets", () => {
    const rec = newRec();
    const s = state([
      [
        ROOT,
        {
          ppid: 1,
          fds: [
            { fd: 0, type: PROX_FDTYPE_VNODE },
            { fd: 1, type: PROX_FDTYPE_VNODE },
            {
              fd: 3,
              type: PROX_FDTYPE_SOCKET,
              socket: { kind: SOCKINFO_IN, lport: 5353, rport: 53, remote: "8.8.8.8" },
            },
            {
              fd: 4,
              type: PROX_FDTYPE_SOCKET,
              socket: { kind: SOCKINFO_UN, lport: 0, rport: 7, remote: "1.2.3.4" },
            },
            tcp(5, 50001, "140.82.112.5"),
          ],
        },
      ],
    ]);
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
    ]);
    expect(rec.nonSocketQueried).toEqual([]);
    expect(rec.socketCalls).toEqual([`${ROOT}/3`, `${ROOT}/4`, `${ROOT}/5`]);
    src.close();
  });

  test("skips listeners (no remote port), zero remote addresses and unknown address families", () => {
    const rec = newRec();
    const s = state([
      [
        ROOT,
        {
          ppid: 1,
          fds: [
            tcp(3, 8080, "0.0.0.0", 0),
            tcp(4, 8081, "9.9.9.9", 0),
            tcp(5, 8082, "0.0.0.0", 443),
            tcp(6, 8083, "0:0:0:0:0:0:0:0", 443),
            {
              fd: 7,
              type: PROX_FDTYPE_SOCKET,
              socket: { kind: SOCKINFO_TCP, lport: 8084, rport: 443, remote: "1.1.1.1", vflag: 0 },
            },
            tcp(8, 50001, "140.82.112.5"),
          ],
        },
      ],
    ]);
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
    ]);
    src.close();
  });

  test("a process that cannot be read is not attributed, and the poll goes on", () => {
    const rec = newRec();
    const s = state([
      [ROOT, { ppid: 1, fds: [tcp(3, 50001, "1.1.1.1")] }],
      // Its parent cannot be read, so it is not known to be in the tree.
      [610, { ppid: ROOT, bsdReadable: false, fds: [tcp(3, 50002, "1.1.1.2")] }],
      // In the tree, but its fd list cannot be read.
      [620, { ppid: ROOT, fdsReadable: false, fds: [tcp(3, 50003, "1.1.1.3")] }],
      // In the tree, but socket info comes back short.
      [630, { ppid: ROOT, socketShort: true, fds: [tcp(3, 50004, "1.1.1.4")] }],
      [640, { ppid: ROOT, fds: [tcp(3, 50005, "1.1.1.5")] }],
    ]);
    const src = openOk(s, rec);
    expect(src.poll().sort(byPort)).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "1.1.1.1", remotePort: 443 },
      { pid: 640, localPort: 50005, remoteIp: "1.1.1.5", remotePort: 443 },
    ]);
    src.close();
  });

  test("a root missing from the listing still has its fds read", () => {
    const rec = newRec();
    const s = state([
      [ROOT, { ppid: 1, fds: [tcp(3, 50001, "1.1.1.1")] }],
      [610, { ppid: ROOT, fds: [tcp(3, 50002, "1.1.1.2")] }],
    ]);
    s.listing = [610];
    const src = openOk(s, rec);
    expect(src.poll()).toHaveLength(2);
    src.close();
  });

  test("grows the PID buffer while the listing fills it, and keeps the grown buffer", () => {
    const rec = newRec();
    const entries: [number, FakeProc][] = [[ROOT, { ppid: 1 }]];
    for (let pid = 1000; pid < 1000 + 9000; pid++) entries.push([pid, { ppid: 1 }]);
    // The descendant is LAST in the listing: a truncated list misses it.
    entries.push([20_000, { ppid: ROOT, fds: [tcp(3, 50002, "1.1.1.2")] }]);
    const s = state(entries);
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: 20_000, localPort: 50002, remoteIp: "1.1.1.2", remotePort: 443 },
    ]);
    const sizes = [...rec.listSizes];
    expect(sizes.length).toBeGreaterThan(1);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1] ?? 0);
    const final = sizes.at(-1) ?? 0;
    expect(final).toBeGreaterThan(entries.length * 4);
    rec.listSizes.length = 0;
    src.poll();
    expect(rec.listSizes).toEqual([final]);
    src.close();
  });

  test("grows the fd buffer for a process with many fds", () => {
    const rec = newRec();
    const fds: FakeFd[] = [];
    for (let fd = 0; fd < 3000; fd++) fds.push({ fd, type: PROX_FDTYPE_VNODE });
    fds.push(tcp(3000, 50001, "1.1.1.1"));
    const s = state([[ROOT, { ppid: 1, fds }]]);
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: ROOT, localPort: 50001, remoteIp: "1.1.1.1", remotePort: 443 },
    ]);
    expect(rec.fdListSizes.length).toBeGreaterThan(1);
    expect(rec.fdListSizes.at(-1) ?? 0).toBeGreaterThan(fds.length * FDINFO_BYTES);
    src.close();
  });

  test("poll throws when the PID list cannot be read", () => {
    for (const rc of [-1, 0]) {
      const rec = newRec();
      const s = state([[ROOT, { ppid: 1 }]]);
      s.listRc = rc;
      const src = openOk(s, rec);
      expect(() => src.poll()).toThrow(/proc_listpids/);
      src.close();
    }
  });

  test("declares the libproc signatures it calls", () => {
    const rec = newRec();
    const src = openOk(state([]), rec);
    expect(rec.decls).toEqual([
      {
        proc_listpids: {
          args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        proc_pidinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
        proc_pidfdinfo: {
          args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
          returns: FFIType.i32,
        },
      },
    ]);
    src.close();
  });

  test("opens libSystem, falls back to libproc, and is an error when neither loads", () => {
    const first = newRec();
    openOk(state([]), first).close();
    expect(first.opened).toEqual(["/usr/lib/libSystem.B.dylib"]);

    const fallback = newRec();
    const s = state([]);
    s.missing = ["/usr/lib/libSystem.B.dylib"];
    openOk(s, fallback).close();
    expect(fallback.opened).toEqual(["/usr/lib/libproc.dylib"]);

    const none = newRec();
    const n = state([]);
    n.missing = ["/usr/lib/libproc.dylib", "/usr/lib/libSystem.B.dylib"];
    const src = openDarwinConnectionSource({ rootPid: ROOT, dlopen: fakeOpen(n, none) });
    expect(src).toEqual({ error: expect.stringContaining("libSystem.B.dylib") });
    expect(src).toEqual({ error: expect.stringContaining("libproc.dylib") });
  });

  test("refuses a root PID that is not a positive integer", () => {
    for (const rootPid of [0, -1, 1.5, Number.NaN]) {
      const rec = newRec();
      const src = openDarwinConnectionSource({ rootPid, dlopen: fakeOpen(state([]), rec) });
      expect(src).toEqual({ error: expect.stringContaining("root PID") });
      expect(rec.opened).toEqual([]);
    }
  });

  test("close closes the library once, and poll after close throws", () => {
    const rec = newRec();
    const src = openOk(state([]), rec);
    src.close();
    src.close();
    expect(rec.closed).toEqual(["/usr/lib/libSystem.B.dylib"]);
    expect(() => src.poll()).toThrow(/closed/);
  });
});

function state(entries: [number, FakeProc][]): FakeState {
  return { procs: new Map(entries) };
}

// ---------------------------------------------------------------------------------------------
// Real OS (macOS)
// ---------------------------------------------------------------------------------------------

const IS_DARWIN = process.platform === "darwin";
/** The real run's answer and timings are printed only on request (`NIMBUS_OBSERVE_METRICS=1`). */
const PRINT_METRICS = process.env["NIMBUS_OBSERVE_METRICS"] === "1";
const POLICY_ID = "nimbus.observe-darwin-test";
const HOST = "api.github.com";

/** Runs under sandbox-exec (or, with --control, outside it). Imports nothing from the repo. */
const CHILD_SOURCE = `
import { spawn } from "node:child_process";
import { connect } from "node:net";
const role = process.argv.includes("--control") ? "control" : "child";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open(port, holdMs) {
  return new Promise((resolve) => {
    const s = connect({ host: ${JSON.stringify(HOST)}, port });
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: "timeout" }); }, 8000);
    s.once("connect", () => {
      clearTimeout(t);
      const r = { ok: true, localPort: s.localPort, remoteIp: s.remoteAddress, remotePort: s.remotePort };
      setTimeout(() => { s.destroy(); resolve(r); }, holdMs);
    });
    s.once("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.code ?? e.message }); });
  });
}
// /usr/bin/curl is the child's GRANDCHILD and owns its own connection. Unthrottled, a request ends
// before a 100 ms poll can land (measured on Windows, Task 1), so the reply is read at 500 B/s; curl
// prints the local port and remote address it used.
function grandchild() {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn("/usr/bin/curl", ["-sS", "--max-time", "20", "--limit-rate", "500",
      "-o", "/dev/null", "-w", "%{local_port} %{remote_ip}", "https://${HOST}/"],
      { stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("error", (e) => resolve({ error: e.message }));
    p.on("close", (code) => {
      const [port, ip] = out.trim().split(" ");
      resolve({ pid: p.pid, exit: code, localPort: Number(port), remoteIp: ip, ms: Date.now() - started,
        stderr: err.slice(0, 500) });
    });
  });
}
await sleep(500);
const connections = await Promise.all([open(443, 1000), open(443, 1000), open(443, 1000)]);
// The premise that this child really is confined: port 80 is not declared, so sandbox-exec refuses it.
const undeclared = role === "child" ? await open(80, 0) : null;
const grand = role === "child" ? await grandchild() : null;
process.stdout.write(JSON.stringify({ role, pid: process.pid, connections, undeclared, grand }) + "\\n");
`;

const DRIVER_SOURCE = (childPath: string, workDir: string) => `
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createSandboxRunner } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../index.ts")).href)};
import { openDarwinConnectionSource } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "darwin-connections.ts")).href)};
const bunDir = dirname(process.execPath);
// Bun reads its own home tree (~/.bun) at startup, not only the binary (sandbox-wrapper-spawn.test.ts).
const policy = { id: ${JSON.stringify(POLICY_ID)}, permissions: {
  network: ["${HOST}:443"],
  filesystem: { read: [${JSON.stringify(workDir)}, bunDir, dirname(bunDir)], write: [join(${JSON.stringify(workDir)}, "out")] } } };
const runner = await createSandboxRunner();
const refusal = runner.canConfine(policy);
if (refusal !== null) { console.log(JSON.stringify({ refusal })); process.exit(0); }
function collect(p) {
  return new Promise((resolve) => {
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("close", (code) => resolve({ out, err, code }));
    p.on("error", (e) => resolve({ out, err: err + e.message, code: -1 }));
  });
}
const child = runner.spawn(process.execPath, [${JSON.stringify(childPath)}], {
  policy, env: { ...process.env }, cwd: ${JSON.stringify(workDir)}, stdio: ["ignore", "pipe", "pipe"],
});
const control = spawn(process.execPath, [${JSON.stringify(childPath)}, "--control"], {
  stdio: ["ignore", "pipe", "pipe"] });
const t0 = performance.now();
const source = openDarwinConnectionSource({ rootPid: child.pid });
const openMs = performance.now() - t0;
if ("error" in source) { child.kill(); control.kill(); console.log(JSON.stringify({ openError: source.error })); process.exit(0); }
const seen = new Map();
const pollMs = [];
let pollErrors = 0;
let firstError = "";
function pass() {
  const s = performance.now();
  try {
    for (const c of source.poll()) seen.set(c.pid + "|" + c.localPort + "|" + c.remoteIp + "|" + c.remotePort, c);
  } catch (e) { pollErrors++; firstError ||= String(e); }
  pollMs.push(performance.now() - s);
}
const timer = setInterval(pass, 100);
const kill = setTimeout(() => { child.kill(); control.kill(); }, 45000);
const [c, k] = await Promise.all([collect(child), collect(control)]);
clearInterval(timer);
clearTimeout(kill);
pass();
source.close();
const cpu = process.cpuUsage();
console.log(JSON.stringify({
  rootPid: child.pid, openMs, pollMs, pollErrors, firstError, rows: [...seen.values()],
  child: { code: c.code, out: c.out, err: c.err.slice(0, 2000) },
  control: { code: k.code, out: k.out, err: k.err.slice(0, 2000) },
  cpuUs: cpu.user + cpu.system,
}));
`;

type Conn = { ok: boolean; localPort?: number; remoteIp?: string; remotePort?: number };
type Report = {
  role: string;
  pid: number;
  connections: Conn[];
  undeclared: (Conn & { error?: string }) | null;
  grand: {
    pid?: number;
    exit?: number;
    localPort?: number;
    remoteIp?: string;
    ms?: number;
    error?: string;
    stderr?: string;
  } | null;
};
type Row = { pid: number; localPort: number; remoteIp: string; remotePort: number };
type DriverAnswer = {
  refusal?: string;
  openError?: string;
  rootPid: number;
  openMs: number;
  pollMs: number[];
  pollErrors: number;
  firstError: string;
  rows: Row[];
  child: { code: number | null; out: string; err: string };
  control: { code: number | null; out: string; err: string };
  cpuUs: number;
};

/** One row as text, so a missing field in what the child reported shows up as `undefined`. */
function rowKey(pid?: number, localPort?: number, remoteIp?: string, remotePort?: number): string {
  return `${pid}|${localPort}|${remoteIp}|${remotePort}`;
}

function report(proc: { code: number | null; out: string; err: string }): Report {
  const line = proc.out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (line === undefined) {
    throw new Error(`no report (exit ${proc.code}): ${proc.out}
${proc.err}`);
  }
  return JSON.parse(line) as Report;
}

describe.skipIf(!IS_DARWIN)("openDarwinConnectionSource (real macOS)", () => {
  // realpath'd: /var is a symlink to /private/var, and the SBPL profile matches the kernel's path.
  const work = IS_DARWIN ? realpathSync(mkdtempSync(join(tmpdir(), "nimbus-observe-darwin-"))) : "";
  afterAll(() => {
    if (work !== "") rmSync(work, { recursive: true, force: true });
  });

  test("finds the sandboxed child's and its curl grandchild's connections and none of the control's", async () => {
    const childPath = join(work, "child.mjs");
    writeFileSync(childPath, CHILD_SOURCE);
    mkdirSync(join(work, "out"));
    const driverDir = mkdtempSync(join(dirname(work), "nimbus-observe-darwin-driver-"));
    const driver = join(driverDir, "driver.ts");
    writeFileSync(driver, DRIVER_SOURCE(childPath, work));
    try {
      // The driver, not this test worker, spawns the children: a node:child_process spawn inside a
      // macOS test worker can lose its child's exit (oven-sh/bun#41024).
      const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90_000,
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const line = stdout.trim().split(/\r?\n/).at(-1);
      if (line === undefined || line === "") throw new Error(`driver gave no answer: ${stderr}`);
      const a = JSON.parse(line) as DriverAnswer;
      // Premise: the runner confines a port-443 policy, and the source opened.
      expect(a.refusal).toBeUndefined();
      expect(a.openError).toBeUndefined();
      expect(a.firstError).toBe("");
      expect(a.pollErrors).toBe(0);

      const child = report(a.child);
      const control = report(a.control);
      // Premise: both really connected, or "found none of the control's" would pass vacuously...
      expect(child.connections.every((x) => x.ok)).toBe(true);
      expect(control.connections.every((x) => x.ok)).toBe(true);
      // ...and the child really is confined (an undeclared port is refused), so this is the
      // sandboxed tree and not an unconfined process that happens to share a parent.
      expect(child.undeclared?.ok).toBe(false);

      // Each of the child's sockets, with the local port, remote address and remote port the child
      // itself saw: a wrong struct offset in any of the three fails here.
      const keys = a.rows.map((r) => rowKey(r.pid, r.localPort, r.remoteIp, r.remotePort));
      for (const conn of child.connections) {
        expect(keys).toContain(rowKey(child.pid, conn.localPort, conn.remoteIp, 443));
      }
      // The grandchild: found through the process tree, owned by curl's own PID.
      expect(child.grand).toMatchObject({ exit: 0 });
      const g = child.grand;
      expect(g?.localPort).toBeGreaterThan(0);
      expect(keys).toContain(rowKey(g?.pid, g?.localPort, g?.remoteIp, 443));
      // Nothing of the control's, and nothing from any process outside the child's tree.
      const controlPorts = control.connections.map((x) => x.localPort);
      expect(a.rows.filter((r) => controlPorts.includes(r.localPort))).toEqual([]);
      expect(a.rows.some((r) => r.pid === control.pid)).toBe(false);
      const tree = new Set([a.rootPid, child.pid, g?.pid]);
      expect(a.rows.filter((r) => !tree.has(r.pid))).toEqual([]);

      const sorted = [...a.pollMs].sort((x, y) => x - y);
      if (PRINT_METRICS) {
        console.log(`[observe-darwin] driver answer: ${line.slice(0, 6000)}`);
        console.log(
          JSON.stringify({
            rootPid: a.rootPid,
            childPid: child.pid,
            grandPid: g?.pid,
            openMs: a.openMs,
            polls: a.pollMs.length,
            pollMsMedian: sorted[Math.floor(sorted.length / 2)],
            pollMsMax: sorted.at(-1),
            driverCpuMs: a.cpuUs / 1000,
            rows: a.rows.length,
            grandchildMs: g?.ms,
          }),
        );
      }
    } finally {
      rmSync(driverDir, { recursive: true, force: true });
    }
  }, 120_000);
});

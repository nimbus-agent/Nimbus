/**
 * The Windows connection source.
 *
 * The first half drives `openWin32ConnectionSource` on ANY host through its `dlopen` seam: the fakes
 * below stand in for iphlpapi/userenv/advapi32/kernel32 and answer through the very pointers the
 * source passes, the way the real Win32 calls do (table bytes into the caller's buffer, a PSID and
 * handles into out-parameters, a SID pointer into the token-information buffer).
 *
 * The second half is the real thing on Windows: a child started through the real sandbox runner
 * (the AppContainer helper) opens connections to a declared host while an unsandboxed control
 * process does the same, and the source must find the child's and none of the control's.
 */

import { type dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi";
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openWin32ConnectionSource } from "./win32-connections.ts";

// ---------------------------------------------------------------------------------------------
// Fake Win32
// ---------------------------------------------------------------------------------------------

type V4Row = {
  state: number;
  local: string;
  lport: number;
  remote: string;
  rport: number;
  pid: number;
};
type V6Row = {
  state: number;
  local: string;
  lport: number;
  remote: string;
  rport: number;
  pid: number;
};

type FakeProcess = {
  /** FILETIME creation time. */
  creation: bigint;
  /** Container label of the process token's AppContainer SID, or null for a normal process. */
  container: string | null;
  /** false: OpenProcess fails (protected or already gone). */
  openable?: boolean;
  /** false: OpenProcessToken fails. */
  tokenReadable?: boolean;
};

interface FakeState {
  v4: V4Row[];
  v6: V6Row[];
  procs: Map<number, FakeProcess>;
  /** The container label DeriveAppContainerSidFromAppContainerName answers for a name. */
  deriveLabel: (name: string) => string;
  deriveHr?: number;
  /** Extra bytes GetExtendedTcpTable claims to need, to force the growing-buffer path. */
  inflate?: number;
  tableRc?: number;
  missing?: readonly string[];
}

interface Rec {
  names: string[];
  derived: number[];
  freed: number[];
  localFreed: number[];
  openProcess: number[];
  openToken: number[];
  handlesOpened: Set<number>;
  handlesClosed: number[];
  /** Process handle -> pid and token handle -> pid, shared by the fake kernel32 and advapi32. */
  procOf: Map<number, number>;
  tokenOf: Map<number, number>;
  libsClosed: string[];
  tableCalls: number[];
}

const MIB_TCP_STATE_LISTEN = 2;
const MIB_TCP_STATE_ESTAB = 5;

/** Keeps every buffer the fake hands out alive for the test's life, so its address stays valid. */
const keep: Buffer[] = [];
/** SID address -> container label, for the fake EqualSid. */
const sidLabel = new Map<number, string>();

function fakeSid(label: string): number {
  const b = Buffer.alloc(16);
  b.write(label.slice(0, 15), "latin1");
  keep.push(b);
  const addr = ptr(b) as number;
  sidLabel.set(addr, label);
  return addr;
}

function view(p: Pointer | number, len: number): Buffer {
  return Buffer.from(toArrayBuffer(p as Pointer, 0, len));
}

function readWide(p: number): string {
  let s = "";
  for (let off = 0; off < 4096; off += 2) {
    const unit = Buffer.from(toArrayBuffer(p as Pointer, off, 2)).readUInt16LE(0);
    if (unit === 0) return s;
    s += String.fromCharCode(unit);
  }
  throw new Error("name buffer is not NUL-terminated");
}

function netPort(port: number): number {
  // Network byte order in the low 16 bits of a DWORD.
  return ((port & 0xff) << 8) | ((port >>> 8) & 0xff);
}

function v4Bytes(addr: string): number[] {
  return addr.split(".").map(Number);
}

function v6Bytes(addr: string): number[] {
  const [head, tail] = addr.includes("::") ? addr.split("::") : [addr, undefined];
  const h = head === "" || head === undefined ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const last = t.at(-1);
  if (last?.includes(".") === true) {
    // An embedded IPv4 tail (`::ffff:a.b.c.d`) is two groups.
    const [a = 0, b = 0, c = 0, d = 0] = last.split(".").map(Number);
    t.splice(-1, 1, ((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
  }
  const groups = [...h, ...new Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.flatMap((g) => {
    const n = Number.parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

function tableBytes(af: number, s: FakeState): Buffer {
  if (af === 2) {
    const b = Buffer.alloc(4 + s.v4.length * 24);
    b.writeUInt32LE(s.v4.length, 0);
    s.v4.forEach((r, i) => {
      const o = 4 + i * 24;
      b.writeUInt32LE(r.state, o);
      Buffer.from(v4Bytes(r.local)).copy(b, o + 4);
      b.writeUInt32LE(netPort(r.lport), o + 8);
      Buffer.from(v4Bytes(r.remote)).copy(b, o + 12);
      b.writeUInt32LE(netPort(r.rport), o + 16);
      b.writeUInt32LE(r.pid, o + 20);
    });
    return b;
  }
  const b = Buffer.alloc(4 + s.v6.length * 56);
  b.writeUInt32LE(s.v6.length, 0);
  s.v6.forEach((r, i) => {
    const o = 4 + i * 56;
    Buffer.from(v6Bytes(r.local)).copy(b, o);
    b.writeUInt32LE(netPort(r.lport), o + 20);
    Buffer.from(v6Bytes(r.remote)).copy(b, o + 24);
    b.writeUInt32LE(netPort(r.rport), o + 44);
    b.writeUInt32LE(r.state, o + 48);
    b.writeUInt32LE(r.pid, o + 52);
  });
  return b;
}

function newRec(): Rec {
  return {
    names: [],
    derived: [],
    freed: [],
    localFreed: [],
    openProcess: [],
    openToken: [],
    handlesOpened: new Set(),
    handlesClosed: [],
    procOf: new Map(),
    tokenOf: new Map(),
    libsClosed: [],
    tableCalls: [],
  };
}

let nextHandle = 0x100;

function fakeLibrary(name: string, s: FakeState, rec: Rec): Record<string, unknown> {
  const { procOf, tokenOf } = rec;
  const libs: Record<string, Record<string, unknown>> = {
    "iphlpapi.dll": {
      GetExtendedTcpTable: (
        buf: number,
        sizeP: number,
        _order: number,
        af: number,
        cls: number,
        _res: number,
      ): number => {
        rec.tableCalls.push(af);
        if (cls !== 5) throw new Error(`unexpected table class ${cls}`);
        if (s.tableRc !== undefined) return s.tableRc;
        const bytes = tableBytes(af, s);
        const size = new Uint32Array(toArrayBuffer(sizeP as Pointer, 0, 4));
        const need = bytes.length + (s.inflate ?? 0);
        if ((size[0] ?? 0) < need) {
          size[0] = need;
          return 122;
        }
        bytes.copy(view(buf, bytes.length));
        return 0;
      },
    },
    "userenv.dll": {
      DeriveAppContainerSidFromAppContainerName: (nameP: number, outP: number): number => {
        const n = readWide(nameP);
        rec.names.push(n);
        if (s.deriveHr !== undefined) return s.deriveHr;
        const addr = fakeSid(s.deriveLabel(n));
        rec.derived.push(addr);
        view(outP, 8).writeBigUInt64LE(BigInt(addr), 0);
        return 0;
      },
    },
    "advapi32.dll": {
      OpenProcessToken: (h: number, access: number, outP: number): number => {
        const pid = procOf.get(h);
        if (pid === undefined || access !== 0x0008) return 0;
        if (s.procs.get(pid)?.tokenReadable === false) return 0;
        rec.openToken.push(pid);
        const t = nextHandle++;
        tokenOf.set(t, pid);
        rec.handlesOpened.add(t);
        view(outP, 8).writeBigUInt64LE(BigInt(t), 0);
        return 1;
      },
      GetTokenInformation: (t: number, cls: number, buf: number, len: number, retP: number) => {
        const pid = tokenOf.get(t);
        if (pid === undefined || cls !== 31 || len < 8) return 0;
        const label = s.procs.get(pid)?.container ?? null;
        view(buf, 8).writeBigUInt64LE(label === null ? 0n : BigInt(fakeSid(label)), 0);
        view(retP, 4).writeUInt32LE(8, 0);
        return 1;
      },
      EqualSid: (a: number, b: number): number => {
        const la = sidLabel.get(a);
        const lb = sidLabel.get(b);
        if (la === undefined || lb === undefined) throw new Error("EqualSid on an unknown SID");
        return la === lb ? 1 : 0;
      },
      FreeSid: (p: number): null => {
        rec.freed.push(p);
        return null;
      },
    },
    "kernel32.dll": {
      OpenProcess: (access: number, _inherit: number, pid: number): number | null => {
        rec.openProcess.push(pid);
        const p = s.procs.get(pid);
        if (p === undefined || p.openable === false || access !== 0x1000) return null;
        const h = nextHandle++;
        procOf.set(h, pid);
        rec.handlesOpened.add(h);
        return h;
      },
      GetProcessTimes: (h: number, c: number, e: number, k: number, u: number): number => {
        const pid = procOf.get(h);
        if (pid === undefined) return 0;
        view(c, 8).writeBigUInt64LE(s.procs.get(pid)?.creation ?? 0n, 0);
        for (const p of [e, k, u]) view(p, 8).writeBigUInt64LE(0n, 0);
        return 1;
      },
      CloseHandle: (h: number): number => {
        rec.handlesClosed.push(h);
        return 1;
      },
      LocalFree: (p: number): null => {
        rec.localFreed.push(p);
        return null;
      },
    },
  };
  const lib = libs[name];
  if (lib === undefined) throw new Error(`unexpected library ${name}`);
  return lib;
}

function fakeOpen(s: FakeState, rec: Rec): typeof dlopen {
  const open = (name: string, decl: Record<string, unknown>) => {
    if (s.missing?.includes(name) === true) throw new Error(`${name}: cannot open shared object`);
    const all = fakeLibrary(name, s, rec);
    const symbols: Record<string, unknown> = {};
    for (const sym of Object.keys(decl)) {
      if (!(sym in all)) throw new Error(`${name} has no symbol ${sym}`);
      symbols[sym] = all[sym];
    }
    return { symbols, close: () => rec.libsClosed.push(name) };
  };
  return open as unknown as typeof dlopen;
}

const PROFILE = "nimbus-ext-com.example.observed";
const EXT = "S-1-15-2-ext";
const OTHER = "S-1-15-2-other";

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    v4: [],
    v6: [],
    procs: new Map(),
    deriveLabel: (n) => (n === PROFILE ? EXT : "S-1-15-2-wrong"),
    ...over,
  };
}

function openOk(s: FakeState, rec: Rec) {
  const src = openWin32ConnectionSource({ profileName: PROFILE, dlopen: fakeOpen(s, rec) });
  if ("error" in src) throw new Error(`open failed: ${src.error}`);
  return src;
}

const est = (pid: number, lport: number, remote: string, rport = 443): V4Row => ({
  state: MIB_TCP_STATE_ESTAB,
  local: "10.0.0.5",
  lport,
  remote,
  rport,
  pid,
});

// ---------------------------------------------------------------------------------------------
// Unit tests (any host)
// ---------------------------------------------------------------------------------------------

describe("openWin32ConnectionSource (fake Win32)", () => {
  test("returns only rows owned by a process whose token carries the derived SID", () => {
    const rec = newRec();
    const s = state({
      procs: new Map([
        [100, { creation: 1n, container: EXT }],
        [200, { creation: 2n, container: OTHER }],
        [300, { creation: 3n, container: null }],
      ]),
      v4: [
        est(100, 50001, "140.82.112.5"),
        est(200, 50002, "140.82.112.5"),
        est(300, 50003, "1.2.3.4"),
      ],
      v6: [
        {
          state: MIB_TCP_STATE_ESTAB,
          local: "2001:db8::5",
          lport: 50004,
          remote: "2606:50c0:8000:0:0:0:0:154",
          rport: 443,
          pid: 100,
        },
        {
          state: MIB_TCP_STATE_ESTAB,
          local: "::1",
          lport: 50005,
          remote: "2001:db8:0:0:1:0:0:1",
          rport: 8443,
          pid: 100,
        },
        {
          state: MIB_TCP_STATE_ESTAB,
          local: "::ffff:10.0.0.5",
          lport: 50006,
          remote: "::ffff:140.82.112.6",
          rport: 443,
          pid: 100,
        },
        {
          state: MIB_TCP_STATE_ESTAB,
          local: "::1",
          lport: 50007,
          remote: "2001:db8::9",
          rport: 80,
          pid: 200,
        },
      ],
    });
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: 100, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
      { pid: 100, localPort: 50004, remoteIp: "2606:50c0:8000::154", remotePort: 443 },
      // RFC 5952: the FIRST of two equal zero runs is the one compressed.
      { pid: 100, localPort: 50005, remoteIp: "2001:db8::1:0:0:1", remotePort: 8443 },
      { pid: 100, localPort: 50006, remoteIp: "::ffff:140.82.112.6", remotePort: 443 },
    ]);
    // Both families are read on every poll.
    expect(rec.tableCalls).toEqual([2, 23]);
    src.close();
  });

  test("skips listeners and rows with no remote address", () => {
    const rec = newRec();
    const s = state({
      procs: new Map([[100, { creation: 1n, container: EXT }]]),
      v4: [
        {
          state: MIB_TCP_STATE_LISTEN,
          local: "0.0.0.0",
          lport: 8080,
          remote: "0.0.0.0",
          rport: 0,
          pid: 100,
        },
        // A listener whose remote field is not zero is still a listener.
        {
          state: MIB_TCP_STATE_LISTEN,
          local: "0.0.0.0",
          lport: 8081,
          remote: "9.9.9.9",
          rport: 0,
          pid: 100,
        },
        {
          state: MIB_TCP_STATE_ESTAB,
          local: "0.0.0.0",
          lport: 8082,
          remote: "0.0.0.0",
          rport: 0,
          pid: 100,
        },
        est(100, 50001, "140.82.112.5"),
      ],
      v6: [
        { state: MIB_TCP_STATE_LISTEN, local: "::", lport: 8080, remote: "::", rport: 0, pid: 100 },
        { state: MIB_TCP_STATE_ESTAB, local: "::", lport: 8083, remote: "::", rport: 0, pid: 100 },
      ],
    });
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([
      { pid: 100, localPort: 50001, remoteIp: "140.82.112.5", remotePort: 443 },
    ]);
    src.close();
  });

  test("passes the profile name as a NUL-terminated UTF-16LE string", () => {
    const rec = newRec();
    const name = "nimbus-ext-com.example.ünï";
    const src = openWin32ConnectionSource({
      profileName: name,
      dlopen: fakeOpen(state({ deriveLabel: () => EXT }), rec),
    });
    expect("error" in src).toBe(false);
    // readWide decodes UTF-16LE code units up to the first NUL; a UTF-8 or unterminated buffer
    // would not round-trip the non-ASCII characters (or would throw).
    expect(rec.names).toEqual([name]);
    if (!("error" in src)) src.close();
  });

  test("caches the verdict while a PID stays in the table, and judges a returning PID again", () => {
    const rec = newRec();
    const procs = new Map<number, FakeProcess>([[100, { creation: 1n, container: EXT }]]);
    const s = state({ procs, v4: [est(100, 50001, "140.82.112.5")] });
    const src = openOk(s, rec);
    for (let i = 0; i < 3; i++) expect(src.poll()).toHaveLength(1);
    // The token is read once; the process is opened every poll only for its creation time.
    expect(rec.openToken).toEqual([100]);

    // The PID leaves the table...
    s.v4 = [];
    expect(src.poll()).toEqual([]);
    // ...and comes back as a different process (recycled PID, new creation time, no container).
    procs.set(100, { creation: 9n, container: null });
    s.v4 = [est(100, 50002, "140.82.112.5")];
    expect(src.poll()).toEqual([]);
    expect(rec.openToken).toEqual([100, 100]);

    // Leaving the table drops the entry outright, whatever the creation time on return: memory is
    // bounded by the PIDs in the current table, not by every PID ever seen.
    s.v4 = [];
    src.poll();
    s.v4 = [est(100, 50003, "140.82.112.5")];
    src.poll();
    expect(rec.openToken).toEqual([100, 100, 100]);
    src.close();
  });

  test("a PID recycled while it stays in the table is judged again by its creation time", () => {
    const rec = newRec();
    const procs = new Map<number, FakeProcess>([[100, { creation: 1n, container: null }]]);
    const s = state({ procs, v4: [est(100, 50001, "140.82.112.5")] });
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([]);
    procs.set(100, { creation: 2n, container: EXT });
    s.v4 = [est(100, 50002, "140.82.112.5")];
    expect(src.poll()).toEqual([
      { pid: 100, localPort: 50002, remoteIp: "140.82.112.5", remotePort: 443 },
    ]);
    expect(rec.openToken).toEqual([100, 100]);
    src.close();
  });

  test("a process that cannot be opened is not attributed and not cached", () => {
    const rec = newRec();
    const procs = new Map<number, FakeProcess>([
      [100, { creation: 1n, container: EXT, openable: false }],
    ]);
    const s = state({ procs, v4: [est(100, 50001, "140.82.112.5")] });
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([]);
    procs.set(100, { creation: 1n, container: EXT });
    expect(src.poll()).toHaveLength(1);
    expect(rec.openProcess).toEqual([100, 100]);
    src.close();
  });

  test("a process whose token cannot be read is not attributed and not cached", () => {
    const rec = newRec();
    const procs = new Map<number, FakeProcess>([
      [100, { creation: 1n, container: EXT, tokenReadable: false }],
    ]);
    const s = state({ procs, v4: [est(100, 50001, "140.82.112.5")] });
    const src = openOk(s, rec);
    expect(src.poll()).toEqual([]);
    procs.set(100, { creation: 1n, container: EXT });
    expect(src.poll()).toHaveLength(1);
    src.close();
  });

  test("judges each PID once per poll and skips PID 0", () => {
    const rec = newRec();
    const s = state({
      procs: new Map([[100, { creation: 1n, container: EXT }]]),
      v4: [est(100, 50001, "1.1.1.1"), est(100, 50002, "1.1.1.2"), est(0, 50003, "1.1.1.3")],
    });
    const src = openOk(s, rec);
    expect(src.poll()).toHaveLength(2);
    expect(rec.openProcess).toEqual([100]);
    src.close();
  });

  test("closes every process and token handle it opens", () => {
    const rec = newRec();
    const s = state({
      procs: new Map([
        [100, { creation: 1n, container: EXT }],
        [200, { creation: 2n, container: null }],
      ]),
      v4: [est(100, 50001, "1.1.1.1"), est(200, 50002, "1.1.1.2")],
    });
    const src = openOk(s, rec);
    src.poll();
    src.poll();
    src.close();
    expect(rec.handlesOpened.size).toBeGreaterThan(0);
    expect(new Set(rec.handlesClosed)).toEqual(rec.handlesOpened);
    expect(rec.handlesClosed).toHaveLength(rec.handlesOpened.size);
  });

  test("grows the table buffer when the table does not fit", () => {
    const rec = newRec();
    const s = state({
      procs: new Map([[100, { creation: 1n, container: EXT }]]),
      v4: [est(100, 50001, "1.1.1.1")],
      inflate: 1 << 20,
    });
    const src = openOk(s, rec);
    expect(src.poll()).toHaveLength(1);
    // First call too small for each family, second succeeds; the grown buffer is then kept.
    expect(rec.tableCalls).toEqual([2, 2, 23, 23]);
    src.poll();
    expect(rec.tableCalls).toEqual([2, 2, 23, 23, 2, 23]);
    src.close();
  });

  test("poll throws when the table cannot be read", () => {
    const rec = newRec();
    const src = openOk(state({ tableRc: 87 }), rec);
    expect(() => src.poll()).toThrow(/GetExtendedTcpTable/);
    src.close();
  });

  test("close frees the derived SID with FreeSid (never LocalFree) and closes every library once", () => {
    const rec = newRec();
    const src = openOk(state(), rec);
    expect(rec.derived).toHaveLength(1);
    src.close();
    src.close();
    expect(rec.freed).toEqual(rec.derived);
    expect(rec.localFreed).toEqual([]);
    expect([...rec.libsClosed].sort((a, b) => a.localeCompare(b))).toEqual([
      "advapi32.dll",
      "iphlpapi.dll",
      "kernel32.dll",
      "userenv.dll",
    ]);
    expect(() => src.poll()).toThrow(/closed/);
  });

  test("a library that will not load is an error, and the ones already loaded are closed", () => {
    const rec = newRec();
    const src = openWin32ConnectionSource({
      profileName: PROFILE,
      dlopen: fakeOpen(state({ missing: ["advapi32.dll"] }), rec),
    });
    expect(src).toEqual({ error: expect.stringContaining("advapi32.dll") });
    expect(rec.libsClosed.length).toBeGreaterThan(0);
    expect(rec.libsClosed).not.toContain("advapi32.dll");
  });

  test("a failed SID derivation is an error and closes the libraries", () => {
    const rec = newRec();
    const src = openWin32ConnectionSource({
      profileName: PROFILE,
      dlopen: fakeOpen(state({ deriveHr: 0x80070057 | 0 }), rec),
    });
    expect(src).toEqual({ error: expect.stringContaining("0x80070057") });
    expect(rec.libsClosed).toHaveLength(4);
    expect(rec.freed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Real OS (Windows)
// ---------------------------------------------------------------------------------------------

const IS_WIN = process.platform === "win32";
const IS_CI = process.env["CI"] === "true";
/** The real run's timings are printed only on request (`NIMBUS_OBSERVE_METRICS=1`). */
const PRINT_METRICS = process.env["NIMBUS_OBSERVE_METRICS"] === "1";
const HELPER =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ??
  resolve(import.meta.dir, "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe");
const READY = IS_WIN && existsSync(HELPER);
const POLICY_ID = "nimbus.observe-win32-test";
const HOST = "api.github.com";

/** Runs inside the AppContainer (or, with --control, outside it). Imports nothing from the repo. */
const CHILD_SOURCE = `
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
const role = process.argv.includes("--control") ? "control" : "child";
const wantGrand = process.argv.includes("--grandchild");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function open() {
  return new Promise((resolve) => {
    const s = connect({ host: ${JSON.stringify(HOST)}, port: 443 });
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: "timeout" }); }, 10000);
    s.once("connect", () => {
      const localPort = s.localPort;
      setTimeout(() => { clearTimeout(t); s.destroy(); resolve({ ok: true, localPort }); }, 1000);
    });
    s.once("error", (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
  });
}
// path.join, not a literal: no backslash has to survive two levels of string escaping.
const SYSTEM32 = join(process.env.SystemRoot ?? "C:/Windows", "System32");
// cmd.exe, then curl.exe: curl is the child's GRANDCHILD and owns the connection. Its output goes to
// FILES: a piped stdio from inside the AppContainer hung (spike 6a). curl is named, not given as a
// full path: from inside the AppContainer, "cmd /c <System32 path>\\curl.exe" answered "Access is
// denied." on a Windows 11 dev machine (2026-11-03) while "cmd /c curl.exe" ran. Unthrottled, the
// request finished in ~40 ms and a 100 ms poll missed it in 9 of 25 runs, so the reply is read at
// 500 B/s (it was 276 bytes on some runs and ~2.4 KB on others: about 0.5 s to 5 s), and curl
// prints the local port it used.
function grandchild() {
  return new Promise((resolve) => {
    const args = ["/d", "/c", "curl.exe", "-sS", "--max-time", "20", "--limit-rate", "500",
      "-o", "NUL", "-w", "%{local_port}", "https://${HOST}/"];
    const outPath = join(process.cwd(), "out", "grandchild-stdout.txt");
    const errPath = join(process.cwd(), "out", "grandchild-stderr.txt");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    const started = Date.now();
    const done = (r) => {
      closeSync(outFd);
      closeSync(errFd);
      resolve({ ...r, ms: Date.now() - started, localPort: Number(readFileSync(outPath, "utf8").trim()),
        stderr: readFileSync(errPath, "utf8").slice(0, 500) });
    };
    let p;
    try {
      p = spawn(join(SYSTEM32, "cmd.exe"), args, {
        stdio: ["ignore", outFd, errFd], windowsHide: true });
    } catch (e) { done({ error: String(e) }); return; }
    p.on("exit", (code) => done({ pid: p.pid, exit: code }));
    p.on("error", (e) => done({ error: e.message }));
  });
}
await sleep(500);
const connections = await Promise.all([open(), open(), open()]);
const grand = wantGrand ? await grandchild() : null;
process.stdout.write(JSON.stringify({ role, pid: process.pid, connections, grand }) + "\\n");
`;

const DRIVER_SOURCE = (childPath: string, workDir: string, grand: boolean) => `
import { spawn } from "node:child_process";
import { createSandboxRunner } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../index.ts")).href)};
import { profileNameFor } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "../win32-argv.ts")).href)};
import { openWin32ConnectionSource } from ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "win32-connections.ts")).href)};
const policy = { id: ${JSON.stringify(POLICY_ID)}, permissions: {
  network: ["${HOST}:443"], filesystem: { read: [${JSON.stringify(workDir)}], write: [${JSON.stringify(join(workDir, "out"))}] } } };
const runner = await createSandboxRunner();
const refusal = runner.canConfine(policy);
if (refusal !== null) { console.log(JSON.stringify({ refusal })); process.exit(0); }
const t0 = performance.now();
const source = openWin32ConnectionSource({ profileName: profileNameFor(policy) });
const openMs = performance.now() - t0;
if ("error" in source) { console.log(JSON.stringify({ openError: source.error })); process.exit(0); }
function collect(p) {
  return new Promise((resolve) => {
    let out = ""; let err = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { err += String(d); });
    p.on("close", (code) => resolve({ out, err, code }));
    p.on("error", (e) => resolve({ out, err: err + e.message, code: -1 }));
  });
}
const childArgs = [${JSON.stringify(childPath)}${grand ? ', "--grandchild"' : ""}];
const child = runner.spawn(process.execPath, childArgs, {
  policy, env: { ...process.env }, cwd: ${JSON.stringify(workDir)}, stdio: ["ignore", "pipe", "pipe"],
  releaseGrantsOnExit: true,
});
const control = spawn(process.execPath, [${JSON.stringify(childPath)}, "--control"], {
  stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const seen = new Map();
const pollMs = [];
let pollErrors = 0;
function pass() {
  const s = performance.now();
  try {
    for (const c of source.poll()) seen.set(c.pid + "|" + c.localPort + "|" + c.remoteIp + "|" + c.remotePort, c);
  } catch (e) { pollErrors++; }
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
  openMs, pollMs, pollErrors, rows: [...seen.values()],
  child: { code: c.code, out: c.out, err: c.err.slice(0, 2000) },
  control: { code: k.code, out: k.out, err: k.err.slice(0, 2000) },
  cpuUs: cpu.user + cpu.system,
}));
`;

type Conn = { ok: boolean; localPort?: number; error?: string };
type Report = {
  role: string;
  pid: number;
  connections: Conn[];
  grand: { pid?: number; exit?: number; localPort?: number; ms?: number; error?: string } | null;
};
type DriverAnswer = {
  refusal?: string;
  openError?: string;
  openMs: number;
  pollMs: number[];
  pollErrors: number;
  rows: { pid: number; localPort: number; remoteIp: string; remotePort: number }[];
  child: { code: number | null; out: string; err: string };
  control: { code: number | null; out: string; err: string };
  cpuUs: number;
};

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

describe.skipIf(!IS_WIN || (!READY && !IS_CI))("openWin32ConnectionSource (real Windows)", () => {
  if (IS_CI && !READY) {
    test("fails loudly instead of silently skipping when the helper is missing on CI", () => {
      // The reason is the received value, so the CI log says why the premise failed.
      const premiseProblem: string | null = READY
        ? null
        : `win32-connections: CI precondition unmet — helper not found at ${HELPER}. A skip and a ` +
          "pass are indistinguishable in a CI summary; build it with `bun run build:sandbox-helper:win32`.";
      expect(premiseProblem).toBeNull();
    });
    return;
  }

  const work = mkdtempSync(join(tmpdir(), "nimbus-observe-win32-"));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    spawnSync(HELPER, ["--delete-profile", `nimbus-ext-${POLICY_ID}`], { windowsHide: true });
  });

  // The windows-latest runner cannot start any process inside the AppContainer except the child
  // itself (spike 6a, 2026-11-03: spawning System32\curl.exe or cmd.exe from inside it threw EPERM,
  // while the same spawn works on a Windows 11 developer machine). So the grandchild test is skipped
  // on CI (visibly, as a skip), and there the one driver run proves the child and the control only.
  const withGrandchild = !IS_CI;

  /** One driver run, shared by both tests. */
  let run: Promise<{ a: DriverAnswer; child: Report; control: Report }> | undefined;
  function driverRun(): Promise<{ a: DriverAnswer; child: Report; control: Report }> {
    run ??= (async () => {
      const childPath = join(work, "child.mjs");
      writeFileSync(childPath, CHILD_SOURCE);
      // The only directory the child may write: where the grandchild's stderr lands.
      mkdirSync(join(work, "out"));
      const driverDir = mkdtempSync(join(work, "driver-"));
      const driver = join(driverDir, "driver.ts");
      writeFileSync(driver, DRIVER_SOURCE(childPath, work, withGrandchild));
      // The helper path is handed to the driver through ITS env: the runner reads it there, not
      // from this test process's environment.
      const proc = Bun.spawn([process.execPath, "--no-env-file", driver], {
        env: { ...process.env, NIMBUS_SANDBOX_HELPER_PATH: HELPER },
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
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
      if (PRINT_METRICS) {
        const sorted = [...a.pollMs].sort((x, y) => x - y);
        console.log(
          JSON.stringify({
            openMs: a.openMs,
            polls: a.pollMs.length,
            pollMsMedian: sorted[Math.floor(sorted.length / 2)],
            pollMsMax: sorted.at(-1),
            driverCpuMs: a.cpuUs / 1000,
            rows: a.rows.length,
            withGrandchild,
          }),
        );
      }
      return { a, child: report(a.child), control: report(a.control) };
    })();
    return run;
  }

  test("finds the sandboxed child's connections and none of the control's", async () => {
    const { a, child, control } = await driverRun();
    expect(a.refusal).toBeUndefined();
    expect(a.openError).toBeUndefined();
    expect(a.pollErrors).toBe(0);

    const childPorts = child.connections.map((x) => x.localPort);
    const controlPorts = control.connections.map((x) => x.localPort);
    // Premise: both really connected, or "found none of the control's" would pass vacuously.
    expect(child.connections.every((x) => x.ok)).toBe(true);
    expect(control.connections.every((x) => x.ok)).toBe(true);

    const attributed = a.rows.filter((r) => r.remotePort === 443);
    for (const port of childPorts) {
      expect(attributed.some((r) => r.localPort === port && r.pid === child.pid)).toBe(true);
    }
    expect(a.rows.filter((r) => controlPorts.includes(r.localPort))).toEqual([]);
    expect(a.rows.some((r) => r.pid === control.pid)).toBe(false);
  }, 120_000);

  test.skipIf(IS_CI)(
    "finds a grandchild's connection through the container SID",
    async () => {
      const { a, child, control } = await driverRun();
      // The whole record on failure: its stderr says why the grandchild could not connect.
      expect(child.grand).toMatchObject({ exit: 0 });
      // curl.exe (under cmd.exe) owns its connection: found by the local port curl reported, owned
      // by a process that is neither the child nor the control.
      const port = child.grand?.localPort;
      expect(port).toBeGreaterThan(0);
      const grand = a.rows.filter((r) => r.remotePort === 443 && r.localPort === port);
      expect(grand.length).toBeGreaterThan(0);
      expect(grand.every((r) => r.pid !== child.pid && r.pid !== control.pid)).toBe(true);
    },
    120_000,
  );
});

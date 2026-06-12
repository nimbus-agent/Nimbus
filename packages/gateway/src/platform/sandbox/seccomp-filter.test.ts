import { describe, expect, it } from "bun:test";
import {
  buildDefaultSeccompFilter,
  type SeccompFilterOverrides,
  SYS_ALLOW,
  SYS_BLOCK_EPERM,
  SYS_KILL_DEFAULT,
} from "./seccomp-filter.ts";

describe("buildDefaultSeccompFilter", () => {
  it("emits a non-empty BPF program", () => {
    const program = buildDefaultSeccompFilter();
    expect(program.length).toBeGreaterThan(0);
  });

  it("includes a BPF_RET for SECCOMP_RET_KILL_PROCESS as the catch-all", () => {
    const program = buildDefaultSeccompFilter();
    const lastInstr = program.slice(-8);
    expect(lastInstr.readUInt16LE(0)).toBe(0x06);
    expect(lastInstr.readUInt32LE(4)).toBe(0x80000000);
  });

  it("classifies key syscalls correctly", () => {
    expect(SYS_ALLOW).toContain("read");
    expect(SYS_ALLOW).toContain("execve");
    expect(SYS_BLOCK_EPERM).toContain("ptrace");
    expect(SYS_BLOCK_EPERM).toContain("mount");
    expect(SYS_BLOCK_EPERM).toContain("setuid");
    expect(SYS_BLOCK_EPERM).toContain("bpf");
    expect(SYS_BLOCK_EPERM).toContain("kexec_load");
    expect(SYS_KILL_DEFAULT).toBe(true);
  });

  it("allows the modern-runtime syscalls a wrapped bun connector needs at startup", () => {
    // Measured via `strace -fc bun <connector>` on Debian/glibc (chatops e2e). Without these the
    // KILL_PROCESS default murders every wrapped connector on a modern distro (SIGSYS, exit 159):
    // rseq/newfstatat are unconditional glibc-startup calls, the rest are Bun's event loop.
    for (const name of [
      "rseq",
      "newfstatat",
      "prctl",
      "sysinfo",
      "eventfd2",
      "close_range",
      "timerfd_create",
      "timerfd_settime",
      "sigaltstack",
      "sched_setscheduler",
      "membarrier",
      // Hit only once the connector processes a request (Bun's epoll loop + thread/signal
      // management + vectored positioned reads): without these the KILL default SIGSYS-kills
      // the connector mid-request, not at startup. Measured via the request-lifecycle strace.
      "epoll_pwait2",
      "rt_sigsuspend",
      "tgkill",
      "preadv2",
    ]) {
      expect(SYS_ALLOW).toContain(name);
    }
  });

  it("throws for an unknown syscall name in the allow list override", () => {
    const overrides: SeccompFilterOverrides = { allowList: ["__no_such_syscall__"] };
    expect(() => buildDefaultSeccompFilter(overrides)).toThrow(
      "unknown syscall in allow list: __no_such_syscall__",
    );
  });

  it("throws for an unknown syscall name in the block list override", () => {
    const overrides: SeccompFilterOverrides = {
      allowList: ["read"],
      blockList: ["__no_such_syscall__"],
    };
    expect(() => buildDefaultSeccompFilter(overrides)).toThrow(
      "unknown syscall in block list: __no_such_syscall__",
    );
  });

  it("accepts explicit overrides and produces a correctly-sized program", () => {
    // allowList=["read"]=1 allow entry, blockList=["ptrace"]=1 block entry
    // Header: 4 instrs, allow: 2, block: 2, catch-all: 1 => total 9 instrs => 72 bytes
    const overrides: SeccompFilterOverrides = {
      allowList: ["read"],
      blockList: ["ptrace"],
    };
    const buf = buildDefaultSeccompFilter(overrides);
    expect(buf.length).toBe(9 * 8);
  });

  it("produces a program with only the header+catch-all when both lists are empty", () => {
    // Header: 4 instrs, no allow, no block, catch-all: 1 => total 5 instrs => 40 bytes
    const overrides: SeccompFilterOverrides = { allowList: [], blockList: [] };
    const buf = buildDefaultSeccompFilter(overrides);
    expect(buf.length).toBe(5 * 8);
    // Last instruction must still be SECCOMP_RET_KILL_PROCESS
    const lastInstr = buf.slice(-8);
    expect(lastInstr.readUInt16LE(0)).toBe(0x06);
    expect(lastInstr.readUInt32LE(4)).toBe(0x80000000);
  });

  it("encodes the arch-check header instructions with correct BPF opcodes and constants", () => {
    const overrides: SeccompFilterOverrides = { allowList: [], blockList: [] };
    const buf = buildDefaultSeccompFilter(overrides);

    // Instr 0: BPF_LD|BPF_W|BPF_ABS loading arch offset (4)
    // code = 0x00|0x00|0x20 = 0x20; jt=0, jf=0, k=4
    expect(buf.readUInt16LE(0 * 8)).toBe(0x20);
    expect(buf.readUInt8(0 * 8 + 2)).toBe(0); // jt
    expect(buf.readUInt8(0 * 8 + 3)).toBe(0); // jf
    expect(buf.readUInt32LE(0 * 8 + 4)).toBe(4); // SECCOMP_DATA_ARCH_OFFSET

    // Instr 1: BPF_JMP|BPF_JEQ|BPF_K comparing to AUDIT_ARCH_X86_64
    // code = 0x05|0x10|0x00 = 0x15; jt=1 (arch matches → skip kill), jf=0, k=0xc000003e
    expect(buf.readUInt16LE(1 * 8)).toBe(0x15);
    expect(buf.readUInt8(1 * 8 + 2)).toBe(1); // jt: jump past the kill instr on match
    expect(buf.readUInt8(1 * 8 + 3)).toBe(0); // jf: fall through to kill on mismatch
    expect(buf.readUInt32LE(1 * 8 + 4)).toBe(0xc000003e); // AUDIT_ARCH_X86_64

    // Instr 2: BPF_RET|BPF_K with SECCOMP_RET_KILL_PROCESS (arch mismatch path)
    expect(buf.readUInt16LE(2 * 8)).toBe(0x06);
    expect(buf.readUInt32LE(2 * 8 + 4)).toBe(0x80000000);

    // Instr 3: BPF_LD|BPF_W|BPF_ABS loading syscall-nr offset (0)
    expect(buf.readUInt16LE(3 * 8)).toBe(0x20);
    expect(buf.readUInt32LE(3 * 8 + 4)).toBe(0); // SECCOMP_DATA_NR_OFFSET
  });

  it("encodes a single allow-list entry with correct SECCOMP_RET_ALLOW value", () => {
    // read = syscall nr 0
    const overrides: SeccompFilterOverrides = { allowList: ["read"], blockList: [] };
    const buf = buildDefaultSeccompFilter(overrides);

    // Header is 4 instrs (indices 0-3); allow entry starts at index 4
    // Instr 4: JEQ read(0) — jt=0 (match→next=RET ALLOW), jf=1 (no-match→skip allow)
    expect(buf.readUInt16LE(4 * 8)).toBe(0x15);
    expect(buf.readUInt8(4 * 8 + 2)).toBe(0); // jt
    expect(buf.readUInt8(4 * 8 + 3)).toBe(1); // jf
    expect(buf.readUInt32LE(4 * 8 + 4)).toBe(0); // syscall nr for "read"

    // Instr 5: RET SECCOMP_RET_ALLOW
    expect(buf.readUInt16LE(5 * 8)).toBe(0x06);
    expect(buf.readUInt32LE(5 * 8 + 4)).toBe(0x7fff0000); // SECCOMP_RET_ALLOW
  });

  it("encodes a single block-list entry with correct SECCOMP_RET_ERRNO_EPERM value", () => {
    // ptrace = syscall nr 101
    const overrides: SeccompFilterOverrides = { allowList: [], blockList: ["ptrace"] };
    const buf = buildDefaultSeccompFilter(overrides);

    // Header 4 instrs (0-3); block entry starts at index 4
    // Instr 4: JEQ ptrace(101)
    expect(buf.readUInt16LE(4 * 8)).toBe(0x15);
    expect(buf.readUInt8(4 * 8 + 2)).toBe(0); // jt
    expect(buf.readUInt8(4 * 8 + 3)).toBe(1); // jf
    expect(buf.readUInt32LE(4 * 8 + 4)).toBe(101); // syscall nr for "ptrace"

    // Instr 5: RET SECCOMP_RET_ERRNO_EPERM
    expect(buf.readUInt16LE(5 * 8)).toBe(0x06);
    expect(buf.readUInt32LE(5 * 8 + 4)).toBe(0x00050001); // SECCOMP_RET_ERRNO_EPERM
  });

  it("program length grows by 2 instructions per allow-list entry", () => {
    const base = buildDefaultSeccompFilter({ allowList: [], blockList: [] });
    const one = buildDefaultSeccompFilter({ allowList: ["read"], blockList: [] });
    const two = buildDefaultSeccompFilter({ allowList: ["read", "write"], blockList: [] });
    expect(one.length - base.length).toBe(2 * 8);
    expect(two.length - one.length).toBe(2 * 8);
  });

  it("program length grows by 2 instructions per block-list entry", () => {
    const base = buildDefaultSeccompFilter({ allowList: [], blockList: [] });
    const one = buildDefaultSeccompFilter({ allowList: [], blockList: ["ptrace"] });
    const two = buildDefaultSeccompFilter({ allowList: [], blockList: ["ptrace", "mount"] });
    expect(one.length - base.length).toBe(2 * 8);
    expect(two.length - one.length).toBe(2 * 8);
  });

  it("defaults to SYS_ALLOW and SYS_BLOCK_EPERM when called with no arguments", () => {
    // The no-arg call exercises both ?? branches taking the defaults
    const defaultBuf = buildDefaultSeccompFilter();
    // Expected size: 4 header + 2*SYS_ALLOW.length + 2*SYS_BLOCK_EPERM.length + 1 catch-all
    const expectedInstrs = 4 + 2 * SYS_ALLOW.length + 2 * SYS_BLOCK_EPERM.length + 1;
    expect(defaultBuf.length).toBe(expectedInstrs * 8);
  });
});

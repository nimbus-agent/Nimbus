import { describe, expect, it } from "bun:test";
import {
  buildDefaultSeccompFilter,
  CLONE_NAMESPACE_FLAGS,
  type SeccompFilterOverrides,
  SYS_ALLOW,
  SYS_BLOCK_EPERM,
  SYS_KILL_ALWAYS,
  SYSCALL_NR,
} from "./seccomp-filter.ts";

describe("buildDefaultSeccompFilter", () => {
  it("emits a non-empty BPF program", () => {
    const program = buildDefaultSeccompFilter();
    expect(program.length).toBeGreaterThan(0);
  });

  it("ends in SECCOMP_RET_ERRNO | ENOSYS as the catch-all", () => {
    const program = buildDefaultSeccompFilter();
    const lastInstr = program.slice(-8);
    expect(lastInstr.readUInt16LE(0)).toBe(0x06);
    expect(lastInstr.readUInt32LE(4)).toBe(0x00050000 | 38);
  });

  it("kills a call from the wrong architecture, not refuses it", () => {
    const program = buildDefaultSeccompFilter();
    expect(program.readUInt16LE(2 * 8)).toBe(0x06);
    expect(program.readUInt32LE(2 * 8 + 4)).toBe(0x80000000);
  });

  it("answers every SYS_KILL_ALWAYS entry with SECCOMP_RET_KILL_PROCESS", () => {
    const program = buildDefaultSeccompFilter();
    for (const name of SYS_KILL_ALWAYS) {
      const nr = SYSCALL_NR[name];
      expect(nr).toBeDefined();
      expect(verdict(program, nr ?? -1)).toBe("kill");
    }
  });

  it("keeps the three lists disjoint", () => {
    const seen = new Map<string, string>();
    for (const [list, names] of [
      ["allow", SYS_ALLOW],
      ["eperm", SYS_BLOCK_EPERM],
      ["kill", SYS_KILL_ALWAYS],
    ] as const) {
      for (const name of names) {
        expect(`${name} in ${seen.get(name) ?? list}`).toBe(`${name} in ${list}`);
        seen.set(name, list);
      }
    }
  });

  it("names only syscalls the number table knows, in every list", () => {
    for (const names of [SYS_ALLOW, SYS_BLOCK_EPERM, SYS_KILL_ALWAYS]) {
      expect(() =>
        buildDefaultSeccompFilter({ allowList: names, blockList: [], killList: [] }),
      ).not.toThrow();
    }
    expect(() =>
      buildDefaultSeccompFilter({ allowList: [], blockList: [], killList: ["__no_such__"] }),
    ).toThrow("unknown syscall in kill list: __no_such__");
  });

  it("answers an unlisted call with ENOSYS", () => {
    const program = buildDefaultSeccompFilter();
    expect(verdict(program, 319)).toBe("enosys"); // memfd_create
    expect(verdict(program, 259)).toBe("enosys"); // mknodat
  });

  it("allows the harmless calls added with the ENOSYS default", () => {
    for (const name of [
      "flock",
      "getrusage",
      "truncate",
      "fallocate",
      "copy_file_range",
      "sendfile",
      "gettimeofday",
      "time",
      "times",
      "alarm",
      "setitimer",
      "getitimer",
      "inotify_init1",
      "inotify_add_watch",
      "inotify_rm_watch",
      "signalfd4",
      "splice",
      "sched_getparam",
      "ioprio_get",
      "pause",
      "getpriority",
      "sync",
      "syncfs",
      "capget",
    ]) {
      expect(SYS_ALLOW).toContain(name);
    }
    for (const name of [
      "memfd_create",
      "mknodat",
      "shmget",
      "semget",
      "mlock",
      "setpriority",
      "rt_sigqueueinfo",
    ]) {
      expect(SYS_ALLOW).not.toContain(name);
    }
  });

  it("classifies key syscalls correctly", () => {
    expect(SYS_ALLOW).toContain("read");
    expect(SYS_ALLOW).toContain("execve");
    // glibc's resolver: without it a child dies on its first DNS lookup on Ubuntu 24.04.
    expect(SYS_ALLOW).toContain("sendmmsg");
    expect(SYS_BLOCK_EPERM).toContain("ptrace");
    expect(SYS_BLOCK_EPERM).toContain("mount");
    expect(SYS_BLOCK_EPERM).toContain("setuid");
    expect(SYS_BLOCK_EPERM).toContain("bpf");
    expect(SYS_BLOCK_EPERM).toContain("kexec_load");
    expect(SYS_KILL_ALWAYS).toContain("setns");
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
    // Header: 4 instrs, allow: 2, block: 2, clone arm: 5, catch-all: 1 => total 14 instrs => 112 bytes
    const overrides: SeccompFilterOverrides = {
      allowList: ["read"],
      blockList: ["ptrace"],
      killList: [],
    };
    const buf = buildDefaultSeccompFilter(overrides);
    expect(buf).toHaveLength(14 * 8);
  });

  it("produces a program with only the header+catch-all when both lists are empty", () => {
    // Header: 4 instrs, no allow, no block, clone arm: 5, catch-all: 1 => total 10 instrs => 80 bytes
    const overrides: SeccompFilterOverrides = { allowList: [], blockList: [], killList: [] };
    const buf = buildDefaultSeccompFilter(overrides);
    expect(buf).toHaveLength(10 * 8);
    // Last instruction must still be SECCOMP_RET_ERRNO | ENOSYS
    const lastInstr = buf.slice(-8);
    expect(lastInstr.readUInt16LE(0)).toBe(0x06);
    expect(lastInstr.readUInt32LE(4)).toBe(0x00050000 | 38);
  });

  it("encodes the arch-check header instructions with correct BPF opcodes and constants", () => {
    const overrides: SeccompFilterOverrides = { allowList: [], blockList: [], killList: [] };
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
    const overrides: SeccompFilterOverrides = { allowList: ["read"], blockList: [], killList: [] };
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
    const overrides: SeccompFilterOverrides = {
      allowList: [],
      blockList: ["ptrace"],
      killList: [],
    };
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
    const base = buildDefaultSeccompFilter({ allowList: [], blockList: [], killList: [] });
    const one = buildDefaultSeccompFilter({ allowList: ["read"], blockList: [], killList: [] });
    const two = buildDefaultSeccompFilter({
      allowList: ["read", "write"],
      blockList: [],
      killList: [],
    });
    expect(one.length - base.length).toBe(2 * 8);
    expect(two.length - one.length).toBe(2 * 8);
  });

  it("program length grows by 2 instructions per block-list entry", () => {
    const base = buildDefaultSeccompFilter({ allowList: [], blockList: [], killList: [] });
    const one = buildDefaultSeccompFilter({ allowList: [], blockList: ["ptrace"], killList: [] });
    const two = buildDefaultSeccompFilter({
      allowList: [],
      blockList: ["ptrace", "mount"],
      killList: [],
    });
    expect(one.length - base.length).toBe(2 * 8);
    expect(two.length - one.length).toBe(2 * 8);
  });

  it("defaults to SYS_ALLOW and SYS_BLOCK_EPERM when called with no arguments", () => {
    // The no-arg call exercises both ?? branches taking the defaults
    const defaultBuf = buildDefaultSeccompFilter();
    // Expected size: 4 header + 5 for the clone arm + 2*SYS_ALLOW.length + 2*SYS_BLOCK_EPERM.length + 1 catch-all
    const expectedInstrs =
      4 + 5 + 2 * SYS_ALLOW.length + 2 * SYS_BLOCK_EPERM.length + 2 * SYS_KILL_ALWAYS.length + 1;
    expect(defaultBuf).toHaveLength(expectedInstrs * 8);
  });
});

/**
 * Runs the program the way the kernel would, for one syscall number on x86-64. `arg0` is the low
 * word of the first argument, which only the `clone` arm reads.
 */
function verdict(program: Buffer, nr: number, arg0 = 0): "allow" | "eperm" | "enosys" | "kill" {
  const ARCH = 0xc000003e;
  let accumulator = 0;
  let pc = 0;
  while (pc * 8 < program.length) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) {
      accumulator = k === 4 ? ARCH : k === 16 ? arg0 : nr;
      pc += 1;
    } else if (code === 0x15) {
      pc += 1 + (accumulator === k ? jt : jf);
    } else if (code === 0x45) {
      pc += 1 + ((accumulator & k) === 0 ? jf : jt);
    } else if (code === 0x06) {
      if (k === 0x7fff0000) return "allow";
      if (k === 0x00050001) return "eperm";
      return k === 0x00050000 + 38 ? "enosys" : "kill";
    } else {
      throw new Error(`unexpected BPF code ${String(code)}`);
    }
  }
  throw new Error("the program fell off its end");
}

describe("what a child may do to itself, and nothing further", () => {
  const program = buildDefaultSeccompFilter();

  it.each<[string, number]>([
    ["kill", 62],
    ["tkill", 200],
    ["tgkill", 234],
    ["fsync", 74],
    ["fdatasync", 75],
    ["umask", 95],
    ["setsid", 112],
    ["setpgid", 109],
    ["getsid", 124],
    ["getpgid", 121],
    ["pidfd_open", 434],
    ["faccessat2", 439],
    ["fadvise64", 221],
    ["getgroups", 115],
    ["getresuid", 118],
    ["getresgid", 120],
    ["sched_getscheduler", 145],
  ])("%s is allowed", (_name, nr) => {
    expect(verdict(program, nr)).toBe("allow");
  });

  it.each<[string, number]>([
    ["flock", 73],
    ["getrusage", 98],
    ["copy_file_range", 326],
    ["gettimeofday", 96],
    ["inotify_init1", 294],
    ["capget", 125],
  ])("%s is allowed since the ENOSYS default", (_name, nr) => {
    expect(verdict(program, nr)).toBe("allow");
  });

  it.each<[string, number]>([
    ["pidfd_getfd", 438],
    ["pidfd_send_signal", 424],
    ["setns", 308],
    ["unshare", 272],
  ])("%s stays killed", (_name, nr) => {
    expect(verdict(program, nr)).toBe("kill");
  });

  it("ptrace stays refused", () => {
    expect(verdict(program, 101)).toBe("eperm");
  });
});

describe("clone and clone3", () => {
  const program = buildDefaultSeccompFilter();
  const CLONE = 56;
  const CLONE3 = 435;
  const SIGCHLD = 17;
  const FLAGS: readonly [string, number][] = [
    ["CLONE_NEWUSER", 0x10000000],
    ["CLONE_NEWNET", 0x40000000],
    ["CLONE_NEWNS", 0x00020000],
    ["CLONE_NEWPID", 0x20000000],
    ["CLONE_NEWIPC", 0x08000000],
    ["CLONE_NEWUTS", 0x04000000],
    ["CLONE_NEWCGROUP", 0x02000000],
    ["CLONE_NEWTIME", 0x00000080],
  ];

  it("keeps neither in an allow, block or kill list, so the arm is their only verdict", () => {
    for (const list of [SYS_ALLOW, SYS_BLOCK_EPERM, SYS_KILL_ALWAYS]) {
      expect(list).not.toContain("clone");
      expect(list).not.toContain("clone3");
    }
  });

  it.each(FLAGS)("kills a clone carrying %s, alone or with ordinary flags", (_name, flag) => {
    expect(verdict(program, CLONE, flag)).toBe("kill");
    expect(verdict(program, CLONE, (flag | 0x00010f00 | SIGCHLD) >>> 0)).toBe("kill");
  });

  it("names exactly those eight flags", () => {
    expect(CLONE_NAMESPACE_FLAGS).toBe(FLAGS.reduce((all, [, f]) => (all | f) >>> 0, 0));
  });

  it("allows a clone with none of them: a thread, a fork, a vfork", () => {
    expect(verdict(program, CLONE, SIGCHLD)).toBe("allow");
    expect(verdict(program, CLONE, 0)).toBe("allow");
    // CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS
    expect(verdict(program, CLONE, 0x003d0f00)).toBe("allow");
    // CLONE_VM | CLONE_VFORK | SIGCHLD
    expect(verdict(program, CLONE, 0x4111)).toBe("allow");
  });

  it("answers clone3 with ENOSYS, since its flags are out of a filter's reach", () => {
    expect(verdict(program, CLONE3)).toBe("enosys");
    expect(verdict(program, CLONE3, 0x10000000)).toBe("enosys");
  });

  it("does not let the arm change another call's verdict", () => {
    expect(verdict(program, 0, 0x10000000)).toBe("allow"); // read, whatever arg0 holds
    expect(verdict(program, 272)).toBe("kill"); // unshare
    expect(verdict(program, 101)).toBe("eperm"); // ptrace
    expect(verdict(program, 319)).toBe("enosys"); // memfd_create
  });
});

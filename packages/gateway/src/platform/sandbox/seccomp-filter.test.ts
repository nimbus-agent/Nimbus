import { describe, expect, it } from "bun:test";
import {
  buildDefaultSeccompFilter,
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
});

/**
 * The child's seccomp filter: an x86-64 allowlist.
 *
 * Order of verdicts, first match wins: allow (`SYS_ALLOW`), refuse with EPERM (`SYS_BLOCK_EPERM`),
 * kill (`SYS_KILL_ALWAYS`), and anything else answers ENOSYS ("function not implemented"). A call
 * from another architecture is killed before any of that.
 *
 * Why the default is ENOSYS and not a kill. The default used to be SECCOMP_RET_KILL_PROCESS, and an
 * allowlist can never be complete across distros and CLIs, so each call it missed killed a connector
 * with SIGSYS, exit 159 and no stderr, which nothing could report or diagnose. That cost three
 * separate bugs on real systems: DNS died on glibc's `sendmmsg`, every subprocess died on Bun's
 * `pidfd_open`, and every shell script died on Fedora, where bash calls `getresuid`. ENOSYS refuses
 * the call exactly as the kill did, so confinement is unchanged: only the failure mode differs, from
 * a silent death to an ordinary error that a program reports or falls back from, as it does for a
 * kernel that predates the call. Docker's default profile answers the same way.
 *
 * `clone3` is on no list, so it answers ENOSYS: its flags live in user memory, where a filter cannot
 * read them, so it cannot be told apart from a namespace request. libc and the runtimes fall back to
 * `clone`, which the filter can check, and Docker's default profile answers the same way.
 *
 * The kill stays for two things. A call from the wrong architecture is a 32-bit ABI bypass attempt
 * (the numbers mean other calls there), not a missing entry. And `SYS_KILL_ALWAYS` lists the calls
 * a confined child has no innocent use for and that could be an escape attempt, so loudly
 * ending that process is the better answer than letting it carry on.
 */
export const SYSCALL_NR: Record<string, number> = {
  read: 0,
  write: 1,
  open: 2,
  close: 3,
  stat: 4,
  fstat: 5,
  lstat: 6,
  poll: 7,
  lseek: 8,
  mmap: 9,
  mprotect: 10,
  munmap: 11,
  brk: 12,
  rt_sigaction: 13,
  rt_sigprocmask: 14,
  rt_sigreturn: 15,
  ioctl: 16,
  pread64: 17,
  pwrite64: 18,
  readv: 19,
  writev: 20,
  access: 21,
  pipe: 22,
  select: 23,
  sched_yield: 24,
  mremap: 25,
  msync: 26,
  mincore: 27,
  madvise: 28,
  dup: 32,
  dup2: 33,
  nanosleep: 35,
  getpid: 39,
  socket: 41,
  connect: 42,
  accept: 43,
  sendto: 44,
  recvfrom: 45,
  sendmsg: 46,
  recvmsg: 47,
  shutdown: 48,
  bind: 49,
  listen: 50,
  getsockname: 51,
  getpeername: 52,
  socketpair: 53,
  setsockopt: 54,
  getsockopt: 55,
  clone: 56,
  fork: 57,
  vfork: 58,
  execve: 59,
  exit: 60,
  wait4: 61,
  fcntl: 72,
  getdents: 78,
  getcwd: 79,
  chdir: 80,
  ftruncate: 77,
  rename: 82,
  mkdir: 83,
  rmdir: 84,
  link: 86,
  unlink: 87,
  symlink: 88,
  readlink: 89,
  chmod: 90,
  fchmod: 91,
  chown: 92,
  fchown: 93,
  lchown: 94,
  umask: 95,
  gettimeofday: 96,
  getrlimit: 97,
  sysinfo: 99,
  getuid: 102,
  getgid: 104,
  geteuid: 107,
  getegid: 108,
  setpgid: 109,
  getppid: 110,
  getpgrp: 111,
  getpgid: 121,
  setsid: 112,
  getsid: 124,
  prctl: 157,
  arch_prctl: 158,
  ptrace: 101,
  mount: 165,
  umount2: 166,
  setuid: 105,
  setgid: 106,
  setreuid: 113,
  setregid: 114,
  setfsuid: 122,
  setfsgid: 123,
  setresuid: 117,
  setresgid: 119,
  bpf: 321,
  kexec_load: 246,
  kexec_file_load: 320,
  init_module: 175,
  finit_module: 313,
  delete_module: 176,
  pivot_root: 155,
  chroot: 161,
  swapon: 167,
  swapoff: 168,
  reboot: 169,
  perf_event_open: 298,
  userfaultfd: 323,
  keyctl: 250,
  add_key: 248,
  request_key: 249,
  futex: 202,
  sched_setaffinity: 203,
  sched_getaffinity: 204,
  set_tid_address: 218,
  set_robust_list: 273,
  openat: 257,
  mkdirat: 258,
  unlinkat: 263,
  renameat: 264,
  fchmodat: 268,
  fchownat: 260,
  faccessat: 269,
  pselect6: 270,
  ppoll: 271,
  epoll_pwait: 281,
  epoll_wait: 232,
  epoll_create1: 291,
  epoll_ctl: 233,
  accept4: 288,
  recvmmsg: 299,
  sendmmsg: 307,
  getrandom: 318,
  statfs: 137,
  fstatfs: 138,
  prlimit64: 302,
  clock_gettime: 228,
  clock_nanosleep: 230,
  exit_group: 231,
  pipe2: 293,
  dup3: 292,
  utimensat: 280,
  futimesat: 261,
  utimes: 235,
  utime: 132,
  gettid: 186,
  rt_sigtimedwait: 128,
  linkat: 265,
  symlinkat: 266,
  readlinkat: 267,
  renameat2: 316,
  execveat: 322,
  waitid: 247,
  statx: 332,
  getdents64: 217,
  openat2: 437,
  quotactl: 179,
  iopl: 172,
  ioperm: 173,
  personality: 135,
  move_pages: 279,
  migrate_pages: 256,
  mbind: 237,
  set_mempolicy: 238,
  get_mempolicy: 239,
  process_vm_readv: 310,
  process_vm_writev: 311,
  uname: 63,
  clone3: 435,
  io_uring_setup: 425,
  io_uring_enter: 426,
  io_uring_register: 427,
  // Modern-runtime syscalls a wrapped bun connector needs at startup (measured via
  // `strace -fc` in the chatops e2e — see seccomp-filter.test.ts).
  rt_sigsuspend: 130,
  sigaltstack: 131,
  sched_setscheduler: 144,
  tgkill: 234,
  newfstatat: 262,
  timerfd_create: 283,
  timerfd_settime: 286,
  eventfd2: 290,
  preadv2: 327,
  membarrier: 324,
  rseq: 334,
  pidfd_open: 434,
  fsync: 74,
  fdatasync: 75,
  kill: 62,
  tkill: 200,
  fadvise64: 221,
  faccessat2: 439,
  getgroups: 115,
  getresuid: 118,
  getresgid: 120,
  sched_getscheduler: 145,
  close_range: 436,
  epoll_pwait2: 441,
  // Added with the ENOSYS default: harmless calls now allowed, and the kill list.
  flock: 73,
  getrusage: 98,
  truncate: 76,
  fallocate: 285,
  copy_file_range: 326,
  sendfile: 40,
  time: 201,
  times: 100,
  alarm: 37,
  setitimer: 38,
  getitimer: 36,
  inotify_init1: 294,
  inotify_add_watch: 254,
  inotify_rm_watch: 255,
  signalfd4: 289,
  splice: 275,
  sched_getparam: 143,
  ioprio_get: 252,
  pause: 34,
  getpriority: 140,
  sync: 162,
  syncfs: 306,
  capget: 125,
  pidfd_getfd: 438,
  pidfd_send_signal: 424,
  setns: 308,
  unshare: 272,
  move_mount: 429,
  open_tree: 428,
  fsopen: 430,
  fsconfig: 431,
  fsmount: 432,
  fspick: 433,
  open_by_handle_at: 304,
  name_to_handle_at: 303,
  acct: 163,
  settimeofday: 164,
  clock_settime: 227,
  adjtimex: 159,
  lookup_dcookie: 212,
  nfsservctl: 180,
  vmsplice: 278,
};

export const SYS_ALLOW: readonly string[] = Object.freeze([
  "read",
  "write",
  "open",
  "openat",
  "close",
  "stat",
  "fstat",
  "lstat",
  "mmap",
  "mprotect",
  "munmap",
  "brk",
  "rt_sigaction",
  "rt_sigprocmask",
  "rt_sigreturn",
  "ioctl",
  "pread64",
  "pwrite64",
  "readv",
  "writev",
  "access",
  "faccessat",
  "pipe",
  "pipe2",
  "select",
  "pselect6",
  "poll",
  "ppoll",
  "epoll_create1",
  "epoll_ctl",
  "epoll_pwait",
  "dup",
  "dup2",
  "dup3",
  "nanosleep",
  "clock_gettime",
  "clock_nanosleep",
  "getpid",
  "gettid",
  "getuid",
  "geteuid",
  "getgid",
  "getegid",
  "getpgrp",
  "getppid",
  "getrandom",
  "fork",
  "vfork",
  "epoll_wait",
  "execve",
  "execveat",
  "wait4",
  "waitid",
  "exit",
  "exit_group",
  "rt_sigtimedwait",
  "arch_prctl",
  "set_tid_address",
  "set_robust_list",
  "prlimit64",
  "getrlimit",
  "socket",
  "socketpair",
  "bind",
  "connect",
  "accept",
  "accept4",
  "listen",
  "sendto",
  "recvfrom",
  "sendmsg",
  "recvmsg",
  "shutdown",
  "getsockname",
  "getpeername",
  "getsockopt",
  "setsockopt",
  "futex",
  "madvise",
  "mincore",
  "mremap",
  "msync",
  "sched_yield",
  "sched_getaffinity",
  "sched_setaffinity",
  "uname",
  "chdir",
  "getcwd",
  "fcntl",
  "lseek",
  "unlink",
  "unlinkat",
  "mkdir",
  "mkdirat",
  "rmdir",
  "rename",
  "renameat",
  "renameat2",
  "chmod",
  "fchmod",
  "fchmodat",
  "chown",
  "fchown",
  "fchownat",
  "link",
  "linkat",
  "symlink",
  "symlinkat",
  "readlink",
  "readlinkat",
  "statfs",
  "fstatfs",
  "getdents",
  "getdents64",
  "utime",
  "utimes",
  "utimensat",
  "futimesat",
  "statx",
  "openat2",
  // Modern-runtime calls (glibc startup + Bun event loop) — without these they fail with ENOSYS
  // (before the default changed, they killed every wrapped connector) on a current distro. None grant privilege: they are
  // thread/registration (rseq, sigaltstack, membarrier), stat (newfstatat), event-loop fds
  // (eventfd2, timerfd_*), fd hygiene (close_range), scheduling (sched_setscheduler), process
  // metadata (prctl, sysinfo).
  "newfstatat",
  "rseq",
  "prctl",
  "sysinfo",
  "eventfd2",
  "close_range",
  "timerfd_create",
  "timerfd_settime",
  "sigaltstack",
  "sched_setscheduler",
  "membarrier",
  // Hit once a wrapped connector processes a request: Bun's epoll event loop (epoll_pwait2),
  // thread/signal management (rt_sigsuspend, tgkill) and vectored positioned reads (preadv2).
  // None grant privilege — they are I/O wait + intra-process signalling.
  "epoll_pwait2",
  "rt_sigsuspend",
  "tgkill",
  "preadv2",
  // Needed the moment a sandboxed workload writes a file through an idiomatic API rather than a
  // raw fd. Measured on Bun 1.3 under this filter: `openSync`+`writeSync`+`closeSync` survives,
  // but BOTH `fs.writeFileSync` and `Bun.write` are SIGSYS-killed with no stderr at all — they
  // truncate through `ftruncate` rather than relying solely on `O_TRUNC`. Without this the
  // `--allow-fs-write` grant is nearly useless: the sandbox permits the write it was asked to
  // permit, and the process dies anyway, for a reason nothing surfaces.
  //
  // It grants no privilege, on the same reasoning as every entry above: `ftruncate` acts on an
  // ALREADY-OPEN fd, so it can only affect a file the bind mounts already made writable. It
  // cannot open anything, reach outside the mounts, or change what is reachable.
  "ftruncate",
  // glibc's resolver sends its A and AAAA queries together with `sendmmsg`. Without it DNS
  // fails on its first lookup on Ubuntu 24.04 (it used to kill the child with no stderr at all), so
  // a network connector started and then failed its first request. It grants nothing
  // `sendto` and `sendmsg` above do not: it is several of the same send on an open socket.
  "sendmmsg",
  // Bun's `child_process.spawn` and `Bun.spawn` call it on the subprocess they just started, to wait
  // for it. Without it a child that ran any subprocess was SIGSYS-killed with no stderr, in every
  // network mode. Measured with strace on Bun 1.4. It grants no reach: a pidfd names a process this
  // one can already see in its own pid namespace.
  "pidfd_open",
  // The rest of what an ordinary program does to its own children, which a connector's CLI is. Each
  // one here SIGSYS-killed the child with no stderr, measured on Bun 1.4.
  //
  // Signals: `child.kill()` and `process.kill(pid, 0)`. Every spawn passes `--unshare-pid`, in every
  // network mode, so a pid here names only a process in the child's own namespace, and `-1` reaches
  // only those. `buildBwrapArgv`'s test pins that. `tgkill` is listed above.
  "kill",
  "tkill",
  // Durability of a file the bind mounts already made writable. They open nothing.
  "fsync",
  "fdatasync",
  // This process's own file mode mask.
  "umask",
  // Sessions and process groups, within the pid namespace: `detached: true`, and a shell's job
  // control. bwrap's `--new-session` has already cut the child off the host's terminal, so a new
  // session cannot get back to it.
  "setsid",
  "setpgid",
  "getsid",
  "getpgid",
  // What strace showed the real CLIs call that the list above lacked. `gcloud` is a bash script, and
  // bash tests a file with `faccessat2`, which is `faccessat` with flags and reads no more than it
  // does. `cat` and the Python in `aws` and `az` call `fadvise64`, a read-ahead hint on an open fd.
  "faccessat2",
  "fadvise64",
  // On Fedora `/usr/bin/sh` is bash, which reads its own ids and scheduler at startup, so every shell
  // script died there before its first line, while Debian's dash passed. `id` calls `getgroups`. All
  // four only read this process's own credentials.
  "getresuid",
  "getresgid",
  "getgroups",
  "sched_getscheduler",
  // NOT here, on purpose, and the filter's test pins that they stay killed: `pidfd_getfd` copies a
  // descriptor out of another process, `pidfd_send_signal` signals through a descriptor that may
  // have been handed in from outside the namespace, and `setns` enters another namespace. `ptrace`
  // stays in `SYS_BLOCK_EPERM`.
  // Harmless calls an ordinary CLI makes, added when the default became ENOSYS. Each acts on an
  // already-open fd, on a path the bind mounts already made reachable, on this process's own clocks,
  // timers, signals or scheduling, or reads its own state; none opens a new route out or grants privilege.
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
  // Left unlisted on purpose, so they answer ENOSYS: `memfd_create`, `mknodat`, `shmget`, `semget`,
  // `mlock`, `setpriority`, `rt_sigqueueinfo`.
]);

export const SYS_BLOCK_EPERM: readonly string[] = Object.freeze([
  "ptrace",
  "process_vm_readv",
  "process_vm_writev",
  "mount",
  "umount2",
  "setuid",
  "setgid",
  "setreuid",
  "setregid",
  "setresuid",
  "setresgid",
  "setfsuid",
  "setfsgid",
  "bpf",
  "kexec_load",
  "kexec_file_load",
  "init_module",
  "finit_module",
  "delete_module",
  "pivot_root",
  "chroot",
  "swapon",
  "swapoff",
  "reboot",
  "quotactl",
  "iopl",
  "ioperm",
  "personality",
  "keyctl",
  "add_key",
  "request_key",
  "move_pages",
  "migrate_pages",
  "mbind",
  "set_mempolicy",
  "get_mempolicy",
  "userfaultfd",
  "perf_event_open",
  "io_uring_setup",
  "io_uring_enter",
  "io_uring_register",
]);

/**
 * Calls a confined child has no innocent use for and that could mean an escape attempt: they reach
 * other processes or namespaces, the mount table, kernel modules or the machine's clock and state,
 * or are known building blocks of exploits. They are killed (SIGSYS), not refused, so an attempt
 * ends the process loudly. Calls already in `SYS_BLOCK_EPERM` (mount, bpf, ...) stay there and answer
 * EPERM; none is repeated here.
 */
export const SYS_KILL_ALWAYS: readonly string[] = Object.freeze([
  "pidfd_getfd",
  "pidfd_send_signal",
  "setns",
  "unshare",
  "move_mount",
  "open_tree",
  "fsopen",
  "fsconfig",
  "fsmount",
  "fspick",
  "open_by_handle_at",
  "name_to_handle_at",
  "acct",
  "settimeofday",
  "clock_settime",
  "adjtimex",
  "lookup_dcookie",
  "nfsservctl",
  "vmsplice",
]);

const BPF_LD = 0x00,
  BPF_W = 0x00,
  BPF_ABS = 0x20;
const BPF_JMP = 0x05,
  BPF_JEQ = 0x10,
  BPF_K = 0x00;
const BPF_JSET = 0x40;
const BPF_RET = 0x06;
const SECCOMP_DATA_ARG0_OFFSET = 16;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_ERRNO_ENOSYS = 0x00050000 | 38;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;

/**
 * `clone` flags that ask for a new namespace. A child that got one could set up a view the outer
 * bwrap never gave it, so a `clone` carrying any of them is killed, the same answer `unshare` gets.
 * Read from the low 32 bits of arg0, as the kernel does. `CLONE_NEWTIME` shares its bit with the
 * exit-signal byte, where 0x80 is not a signal `clone` accepts, so it costs a real call nothing.
 */
const CLONE_NEWTIME = 0x00000080;
const CLONE_NEWNS = 0x00020000;
const CLONE_NEWCGROUP = 0x02000000;
const CLONE_NEWUTS = 0x04000000;
const CLONE_NEWIPC = 0x08000000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
export const CLONE_NAMESPACE_FLAGS =
  (CLONE_NEWTIME |
    CLONE_NEWNS |
    CLONE_NEWCGROUP |
    CLONE_NEWUTS |
    CLONE_NEWIPC |
    CLONE_NEWUSER |
    CLONE_NEWPID |
    CLONE_NEWNET) >>>
  0;

interface SockFilter {
  code: number;
  jt: number;
  jf: number;
  k: number;
}

function instr(code: number, jt: number, jf: number, k: number): SockFilter {
  return { code, jt, jf, k };
}

function emit(filters: SockFilter[]): Buffer {
  const buf = Buffer.alloc(filters.length * 8);
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (f === undefined) continue;
    buf.writeUInt16LE(f.code, i * 8);
    buf.writeUInt8(f.jt, i * 8 + 2);
    buf.writeUInt8(f.jf, i * 8 + 3);
    buf.writeUInt32LE(f.k, i * 8 + 4);
  }
  return buf;
}

/** Optional overrides for testing — production callers omit both parameters. */
export interface SeccompFilterOverrides {
  allowList?: readonly string[];
  blockList?: readonly string[];
  killList?: readonly string[];
}

export function buildDefaultSeccompFilter(overrides: SeccompFilterOverrides = {}): Buffer {
  const allowList = overrides.allowList ?? SYS_ALLOW;
  const blockList = overrides.blockList ?? SYS_BLOCK_EPERM;
  const killList = overrides.killList ?? SYS_KILL_ALWAYS;

  const program: SockFilter[] = [];
  program.push(
    instr(BPF_LD | BPF_W | BPF_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET),
    instr(BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AUDIT_ARCH_X86_64),
    instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instr(BPF_LD | BPF_W | BPF_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET),
  );

  for (const name of allowList) {
    const nr = SYSCALL_NR[name];
    if (nr === undefined) {
      throw new Error(`unknown syscall in allow list: ${name}`);
    }
    program.push(
      instr(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr),
      instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
    );
  }
  for (const name of blockList) {
    const nr = SYSCALL_NR[name];
    if (nr === undefined) {
      throw new Error(`unknown syscall in block list: ${name}`);
    }
    program.push(
      instr(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr),
      instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO_EPERM),
    );
  }
  for (const name of killList) {
    const nr = SYSCALL_NR[name];
    if (nr === undefined) {
      throw new Error(`unknown syscall in kill list: ${name}`);
    }
    program.push(
      instr(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, nr),
      instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    );
  }
  // clone: allowed unless it asks for a namespace. It is on no list, so this is its only verdict. Both
  // arms return, so loading arg0 into the accumulator leaves nothing after it to be misread.
  program.push(
    instr(BPF_JMP | BPF_JEQ | BPF_K, 0, 4, SYSCALL_NR["clone"] ?? -1),
    instr(BPF_LD | BPF_W | BPF_ABS, 0, 0, SECCOMP_DATA_ARG0_OFFSET),
    instr(BPF_JMP | BPF_JSET | BPF_K, 0, 1, CLONE_NAMESPACE_FLAGS),
    instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
    instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW),
  );
  program.push(instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO_ENOSYS));
  return emit(program);
}

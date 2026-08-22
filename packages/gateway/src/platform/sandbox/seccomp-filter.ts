const SYSCALL_NR: Record<string, number> = {
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
  close_range: 436,
  epoll_pwait2: 441,
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
  "clone",
  "clone3",
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
  // Modern-runtime calls (glibc startup + Bun event loop) — without these the KILL default
  // SIGSYS-kills every wrapped connector on a current distro. None grant privilege: they are
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

export const SYS_KILL_DEFAULT = true;

const BPF_LD = 0x00,
  BPF_W = 0x00,
  BPF_ABS = 0x20;
const BPF_JMP = 0x05,
  BPF_JEQ = 0x10,
  BPF_K = 0x00;
const BPF_RET = 0x06;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;
const AUDIT_ARCH_X86_64 = 0xc000003e;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_ERRNO_EPERM = 0x00050001;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;

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
}

export function buildDefaultSeccompFilter(overrides: SeccompFilterOverrides = {}): Buffer {
  const allowList = overrides.allowList ?? SYS_ALLOW;
  const blockList = overrides.blockList ?? SYS_BLOCK_EPERM;

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
  program.push(instr(BPF_RET | BPF_K, 0, 0, SECCOMP_RET_KILL_PROCESS));
  return emit(program);
}

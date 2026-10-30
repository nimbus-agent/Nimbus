// THROWAWAY. Today's bwrap shape (--share-net + the real seccomp filter), real DNS, real TLS.
// Under strace, so a seccomp kill names its syscall in si_syscall.
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultSeccompFilter, SYS_ALLOW } from "/repo/packages/gateway/src/platform/sandbox/seccomp-filter.ts";

const dir = mkdtempSync("/tmp/sc-");
const child = join(dir, "child.ts");
writeFileSync(
  child,
  `const r = await fetch("https://api.github.com/zen", { signal: AbortSignal.timeout(10000), headers: { "user-agent": "nimbus-spike" } })
  .then((x) => "status " + x.status, (e) => "ERR " + String(e).slice(0, 80));
console.log("CHILD:", r);
process.exit(0);`,
);

function bwrapArgs(): string[] {
  return [
    "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-user", "--new-session", "--die-with-parent",
    "--share-net",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", dir, dir, "--chdir", dir,
    "--seccomp", "3",
    "/usr/local/bin/bun", "--no-env-file", child,
  ];
}

function run(label: string, filter: Buffer, strace: boolean): void {
  const p = join(dir, `${label}.bpf`);
  writeFileSync(p, filter);
  const fd = openSync(p, "r");
  const log = join(dir, `${label}.strace`);
  const cmd = strace ? "strace" : "/usr/bin/bwrap";
  const args = strace
    ? ["-f", "-qq", "-e", "trace=none", "-e", "signal=SIGSYS", "-o", log, "/usr/bin/bwrap", ...bwrapArgs()]
    : bwrapArgs();
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe", fd] });
  console.log(`\n===== ${label}`);
  console.log(r.stdout.trim());
  if (r.stderr.trim() !== "") console.log("stderr:", r.stderr.trim().slice(0, 300));
  console.log("exit", r.status, "signal", r.signal);
  if (strace) {
    const t = spawnSync("grep", ["-a", "SIGSYS", log], { encoding: "utf8" });
    console.log("strace:", t.stdout.trim().slice(0, 400) || "(no SIGSYS)");
  }
}

run("today-filter", buildDefaultSeccompFilter(), false);
run("today-filter-strace", buildDefaultSeccompFilter(), true);
run("plus-sendmmsg", buildDefaultSeccompFilter({ allowList: [...SYS_ALLOW] }), false);
process.exit(0);

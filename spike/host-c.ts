// THROWAWAY. Forwarder variant C (one bwrap, launcher applies the real filter) under strace, so the
// seccomp kill names its syscall.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultSeccompFilter } from "/repo/packages/gateway/src/platform/sandbox/seccomp-filter.ts";

const BUN = "/usr/local/bin/bun";
const dir = mkdtempSync("/tmp/fs-");
const sock = join(dir, "p.sock");
const hosts = join(dir, "hosts");
const cwd = join(dir, "cwd");
mkdirSync(cwd);
copyFileSync("/fw/payload.ts", join(cwd, "payload.ts"));
writeFileSync(hosts, "127.0.0.1 localhost\n127.0.0.2 api.github.com\n");
const bpf = join(dir, "seccomp.bpf");
writeFileSync(bpf, buildDefaultSeccompFilter());
const target = Bun.spawn([BUN, "--no-env-file", "/fw/target.ts", sock], { stdout: "inherit", stderr: "inherit" });
await new Promise((r) => setTimeout(r, 400));

const log = join(dir, "strace.log");
const fd = openSync(bpf, "r");
const r = spawnSync(
  "strace",
  [
    "-f", "-qq", "-e", "trace=none", "-e", "signal=SIGSYS", "-o", log,
    "/usr/bin/bwrap",
    "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64", "--ro-bind", hosts, "/etc/hosts",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", dir, dir,
    "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent",
    "--uid", "0", "--gid", "0",
    "--cap-add", "CAP_NET_BIND_SERVICE", "--cap-add", "CAP_SETPCAP",
    "--setenv", "SPIKE_SOCK", sock,
    "--unshare-uts", "--unshare-ipc", "--new-session", "--chdir", cwd,
    "/usr/local/bin/spike-launcher", sock, "127.0.0.2", "443", "--",
    BUN, "--no-env-file", join(cwd, "payload.ts"),
  ],
  { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe", fd] },
);
console.log(r.stdout.trim());
console.log(r.stderr.trim().slice(0, 500));
console.log("exit", r.status, "signal", r.signal);
const t = spawnSync("grep", ["-a", "SIGSYS", log], { encoding: "utf8" });
console.log("strace:", t.stdout.trim().slice(0, 600) || "(no SIGSYS)");
target.kill();
process.exit(0);

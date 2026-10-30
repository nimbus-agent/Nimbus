// THROWAWAY. Variant A: launcher runs the payload directly. Variant B: launcher runs today's bwrap
// argv (copied from buildBwrapArgv, --share-net, real seccomp filter) nested inside.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultSeccompFilter } from "../packages/gateway/src/platform/sandbox/seccomp-filter.ts";

const BUN = "/usr/local/bin/bun-spike";
const dir = mkdtempSync("/tmp/fs-");
const sock = join(dir, "p.sock");
const hosts = join(dir, "hosts");
const cwd = join(dir, "cwd");
mkdirSync(cwd);
copyFileSync(join(import.meta.dir, "payload.ts"), join(cwd, "payload.ts"));
writeFileSync(hosts, "127.0.0.1 localhost\n127.0.0.2 api.github.com\n");
const seccompPath = join(dir, "seccomp.bpf");
writeFileSync(seccompPath, buildDefaultSeccompFilter());

const target = Bun.spawn([BUN, "--no-env-file", join(import.meta.dir, "target.ts"), sock], {
  stdout: "inherit",
  stderr: "inherit",
});
await new Promise((r) => setTimeout(r, 400));

const uid = String(process.getuid?.() ?? 1001);
const gid = String(process.getgid?.() ?? 1001);
const outer = [
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib",
  "--ro-bind-try", "/lib64", "/lib64", "--ro-bind", hosts, "/etc/hosts",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--bind", dir, dir,
  "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent",
  "--uid", "0", "--gid", "0",
  "--cap-add", "CAP_NET_BIND_SERVICE", "--cap-add", "CAP_SETPCAP",
  "--setenv", "SPIKE_SOCK", sock,
];
const launcher = ["/usr/local/bin/spike-launcher", sock, "127.0.0.2", "443", "--"];
const inner = [
  "/usr/bin/bwrap",
  "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-user", "--new-session", "--die-with-parent",
  "--share-net",
  "--uid", uid, "--gid", gid,
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
  "--bind", cwd, cwd, "--chdir", cwd,
  "--ro-bind-try", "/lib64", "/lib64",
  "--seccomp", "3",
];
const payload = (p: string): string[] => [BUN, "--no-env-file", p];

const variants: [string, string[]][] = [
  ["A: payload directly under launcher", [...outer, ...launcher, ...payload(join(cwd, "payload.ts"))]],
  ["B: today's bwrap argv + real seccomp nested", [...outer, ...launcher, ...inner, ...payload(join(cwd, "payload.ts"))]],
];
for (const [label, argv] of variants) {
  console.log(`\n===== ${label}`);
  const fd = openSync(seccompPath, "r");
  const r = spawnSync("/usr/bin/bwrap", argv, {
    encoding: "utf8",
    timeout: 60000,
    stdio: ["ignore", "pipe", "pipe", fd],
  });
  console.log(r.stdout.trim());
  console.log(r.stderr.trim());
  console.log("exit", r.status);
}
await new Promise((r) => setTimeout(r, 200));
target.kill();
process.exit(0);

// THROWAWAY. Exact argv + real filter + sendmmsg, across strace and the resolver bind.
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDefaultSeccompFilter } from "/repo/packages/gateway/src/platform/sandbox/seccomp-filter.ts";
const base = buildDefaultSeccompFilter();
const b = Buffer.alloc(16);
b.writeUInt16LE(0x15, 0); b.writeUInt8(1, 3); b.writeUInt32LE(307, 4); b.writeUInt16LE(0x06, 8); b.writeUInt32LE(0x7fff0000, 12);
const filter = Buffer.concat([base.subarray(0, base.length - 8), b, base.subarray(base.length - 8)]);
const dir = mkdtempSync("/tmp/ct-");
const bpf = join(dir, "f.bpf");
writeFileSync(bpf, filter);
const child = join(dir, "c.ts");
writeFileSync(child, `const { lookup } = await import("node:dns/promises");
console.log(await lookup("nimbus-sandbox-check.invalid").then(() => "RESOLVED", (e) => e.code));
console.log(await lookup("api.github.com").then((r) => "ok " + r.address, (e) => e.code));
process.exit(0);`);
const argv = (bind: boolean) => [
  "--unshare-pid", "--unshare-uts", "--unshare-ipc", "--unshare-user", "--new-session", "--die-with-parent", "--share-net",
  "--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/lib", "/lib",
  "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", dir, dir, "--chdir", dir,
  "--ro-bind-try", "/lib64", "/lib64",
  ...(bind ? ["--ro-bind", "/run/systemd/resolve/stub-resolv.conf", "/run/systemd/resolve/stub-resolv.conf"] : []),
  "--seccomp", "3", "/usr/local/bin/bun", "--no-env-file", child,
];
for (const [label, strace, bind] of [["no strace, no bind", false, false], ["strace, no bind", true, false], ["no strace, bind", false, true]] as const) {
  const fd = openSync(bpf, "r");
  const r = strace
    ? spawnSync("strace", ["-f", "-n", "-o", join(dir, "t.log"), "/usr/bin/bwrap", ...argv(bind)], { encoding: "utf8", timeout: 40000, stdio: ["ignore", "pipe", "pipe", fd] })
    : spawnSync("/usr/bin/bwrap", argv(bind), { encoding: "utf8", timeout: 40000, stdio: ["ignore", "pipe", "pipe", fd] });
  console.log(`${label}: exit ${r.status} [${r.stdout.trim().replace(/\n/g, " | ")}] ${r.stderr.trim().slice(0, 120)}`);
}
process.exit(0);

// THROWAWAY. Today's bwrap argv and real filter. Trace everything, name the syscall each killed
// thread died on, allow it in a copy of the filter, and repeat until the child survives.
import { spawnSync } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDefaultSeccompFilter,
  SYS_ALLOW,
  SYS_BLOCK_EPERM,
} from "/repo/packages/gateway/src/platform/sandbox/seccomp-filter.ts";

const dir = mkdtempSync("/tmp/sc-");
const CASES: Record<string, string> = {
  "fetch real host": `const r = await fetch("https://api.github.com/zen", { signal: AbortSignal.timeout(10000), headers: { "user-agent": "nimbus-spike" } }).then((x) => "status " + x.status, (e) => "ERR " + String(e).slice(0, 80)); console.log("CHILD:", r); process.exit(0);`,
  "lookup that cannot resolve": `const { lookup } = await import("node:dns/promises"); const r = await lookup("nimbus-spike.invalid").then((x) => JSON.stringify(x), (e) => "ERR " + e.code); console.log("CHILD:", r); process.exit(0);`,
  "node:https real host": `const https = await import("node:https"); const r = await new Promise((res) => { https.get("https://api.github.com/zen", { headers: { "user-agent": "nimbus-spike" } }, (x) => res("status " + x.statusCode)).on("error", (e) => res("ERR " + e.code)); }); console.log("CHILD:", r); process.exit(0);`,
};

/** Insert `nr == X -> ALLOW` before the final default-kill instruction. Accumulator still holds nr. */
function withAllowed(base: Buffer, nrs: readonly number[]): Buffer {
  const parts = [base.subarray(0, base.length - 8)];
  for (const nr of nrs) {
    const b = Buffer.alloc(16);
    b.writeUInt16LE(0x15, 0); // JMP|JEQ|K
    b.writeUInt8(0, 2);
    b.writeUInt8(1, 3);
    b.writeUInt32LE(nr, 4);
    b.writeUInt16LE(0x06, 8); // RET|K
    b.writeUInt32LE(0x7fff0000, 12);
    parts.push(b);
  }
  parts.push(base.subarray(base.length - 8));
  return Buffer.concat(parts);
}

const known = new Set<string>([...SYS_ALLOW, ...SYS_BLOCK_EPERM]);
const base = buildDefaultSeccompFilter();

for (const [label, code] of Object.entries(CASES)) {
  console.log(`\n===== ${label}`);
  const child = join(dir, "child.ts");
  writeFileSync(child, code);
  const allowed = new Map<number, string>();
  for (let round = 0; round < 10; round++) {
    const bpf = join(dir, "f.bpf");
    writeFileSync(bpf, withAllowed(base, [...allowed.keys()]));
    const fd = openSync(bpf, "r");
    const log = join(dir, "t.log");
    const r = spawnSync(
      "strace",
      [
        "-f",
        "-n",
        "-o",
        log,
        "/usr/bin/bwrap",
        "--unshare-pid",
        "--unshare-uts",
        "--unshare-ipc",
        "--unshare-user",
        "--new-session",
        "--die-with-parent",
        "--share-net",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/etc",
        "/etc",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--bind",
        dir,
        dir,
        "--chdir",
        dir,
        "--seccomp",
        "3",
        "/usr/local/bin/bun",
        "--no-env-file",
        child,
      ],
      { encoding: "utf8", timeout: 45000, stdio: ["ignore", "pipe", "pipe", fd] },
    );
    const lines = readFileSync(log, "utf8").split("\n");
    const lastByPid = new Map<string, string>();
    for (const l of lines) {
      const m = /^(\d+)\s+\[\s*(\d+)\]\s+(\w+)\(/.exec(l);
      if (m !== null) lastByPid.set(m[1] as string, l);
    }
    const killed = lines.filter((l) => l.includes("killed by SIGSYS")).length;
    const fresh = new Map<number, string>();
    for (const l of lastByPid.values()) {
      const m = /\[\s*(\d+)\]\s+(\w+)\(/.exec(l);
      if (m !== null && !known.has(m[2] as string) && !allowed.has(Number(m[1]))) {
        fresh.set(Number(m[1]), m[2] as string);
      }
    }
    const out = r.stdout.trim().slice(0, 160);
    console.log(
      `round ${round}: exit ${r.status} killedThreads ${killed} output [${out}] newlyBlocked ${JSON.stringify([...fresh.values()])}`,
    );
    if (killed === 0) {
      console.log(`SURVIVES. Needed beyond today's list: ${JSON.stringify([...allowed.values()])}`);
      break;
    }
    if (fresh.size === 0) {
      console.log("killed, but could not name a syscall. Last lines:");
      for (const l of [...lastByPid.values()].slice(0, 6)) console.log("  " + l.slice(0, 140));
      break;
    }
    for (const [nr, name] of fresh) allowed.set(nr, name);
  }
}
process.exit(0);

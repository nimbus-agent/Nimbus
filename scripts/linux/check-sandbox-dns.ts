// Name resolution through the real Linux runner: its bwrap argv and its real seccomp filter. Every
// other sandbox test uses no DNS, which is how a child dying on its first lookup on Ubuntu 24.04
// stayed green. A reserved name makes no outside connection: the machine's own resolver answers.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createLinuxSandboxRunner } from "../../packages/gateway/src/platform/sandbox/linux.ts";

const CHILD = `
const { lookup } = await import("node:dns/promises");
const code = await lookup("nimbus-sandbox-check.invalid").then(() => "RESOLVED", (e) => e.code);
console.log(code);
process.exit(0);
`;

function resolveInSandbox(network: string[]): Promise<{ exit: number | null; out: string }> {
  const runner = createLinuxSandboxRunner();
  const exe = realpathSync(process.execPath);
  const child = runner.spawn(exe, ["--no-env-file", "-e", CHILD], {
    policy: {
      id: "dns-check",
      permissions: { network, filesystem: { read: [dirname(exe)], write: [] } },
    },
    env: { PATH: "/usr/bin" },
    cwd: mkdtempSync(join(tmpdir(), "nimbus-dns-check-")),
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.on("error", reject);
    child.on("close", (exit) => resolve({ exit, out: out.trim() }));
  });
}

// ENOTFOUND is an answer, so the resolver was reachable. EAI_AGAIN would mean it was not, and a
// seccomp kill shows as exit 159 with no output at all.
const withNetwork = await resolveInSandbox(["api.github.com"]);
console.log(`  network declared: exit ${String(withNetwork.exit)}, lookup ${withNetwork.out}`);
if (withNetwork.exit !== 0 || withNetwork.out !== "ENOTFOUND") {
  console.error("check-sandbox-dns: a network-declaring child could not resolve a name");
  process.exit(1);
}

// No network, so the lookup must fail, and fail without killing the child.
const noNetwork = await resolveInSandbox([]);
console.log(`  no network: exit ${String(noNetwork.exit)}, lookup ${noNetwork.out}`);
if (noNetwork.exit !== 0 || noNetwork.out === "RESOLVED" || noNetwork.out === "") {
  console.error("check-sandbox-dns: a no-network child died on, or got an answer to, a lookup");
  process.exit(1);
}
process.exit(0);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

/**
 * The per-host network path against the REAL helper, with the capability the packages grant it
 * (`cap_net_admin+ep`) and as an unprivileged user: `--check-caps` passing must mean a declared
 * host is actually reachable. CI's helper step sets NIMBUS_REQUIRE_SANDBOX_HELPER, so a helper
 * that was not built or not given its capability fails here rather than skipping.
 */
const HELPER = join(import.meta.dir, "../../../src-native/sandbox-helper/nimbus-sandbox-helper");
const BWRAP = "/usr/bin/bwrap";
const REQUIRED = process.env["NIMBUS_REQUIRE_SANDBOX_HELPER"] === "1";

function helperPassesItsProbe(): boolean {
  if (process.platform !== "linux" || !existsSync(HELPER)) return false;
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const r = spawnSync(HELPER, ["--check-caps"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "OK";
}

function hostAddress(): string | undefined {
  const addresses = Object.values(networkInterfaces()).flat();
  return addresses.find((a) => a !== undefined && a.family === "IPv4" && !a.internal)?.address;
}

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("listener has no port"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/** Prints one JSON line naming what each port did. Inline and zero-import, like the other probes. */
function probeScript(host: string, ports: readonly number[]): string {
  return `
const net = require("node:net");
const attempt = (port) => new Promise((resolve) => {
  const s = net.connect({ host: ${JSON.stringify(host)}, port });
  const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 2000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); });
  s.on("error", (e) => { clearTimeout(t); resolve(e.code ?? "error"); });
});
const out = [];
for (const port of ${JSON.stringify(ports)}) out.push(await attempt(port));
console.log(JSON.stringify(out));
process.exit(0);
`;
}

function bwrapArgv(script: string): string[] {
  return [
    BWRAP,
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--unshare-user",
    "--unshare-pid",
    "--share-net",
    "--die-with-parent",
    process.execPath,
    "--no-env-file",
    "-e",
    script,
  ];
}

/** Async: the listeners live in THIS process, so a synchronous spawn would starve their accepts. */
async function run(argv: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

const ready = helperPassesItsProbe();

describe.skipIf(process.platform !== "linux" || (!ready && !REQUIRED))(
  "nimbus-sandbox-helper per-host network",
  () => {
    const address = hostAddress();
    let allowed: { server: Server; port: number };
    let other: { server: Server; port: number };

    beforeAll(async () => {
      expect(ready).toBe(true);
      expect(address).toBeDefined();
      allowed = await listen("0.0.0.0");
      other = await listen("0.0.0.0");
    });

    afterAll(() => {
      allowed?.server.close();
      other?.server.close();
    });

    test("control: the same child under bwrap alone reaches both listeners", async () => {
      const script = probeScript(address as string, [allowed.port, other.port]);
      const r = await run(bwrapArgv(script));
      expect(r).toEqual({
        exitCode: 0,
        stdout: JSON.stringify(["connected", "connected"]),
        stderr: "",
      });
    });

    test("a helper that passes --check-caps starts its child", async () => {
      const r = await run([HELPER, "--allow", `${address}:${allowed.port}`, "--", "/bin/true"]);
      expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });

    test("the child reaches the allowed host and port, and no other port", async () => {
      const script = probeScript(address as string, [allowed.port, other.port]);
      const r = await run([
        HELPER,
        "--allow",
        `${address}:${allowed.port}`,
        "--",
        ...bwrapArgv(script),
      ]);
      expect(r.stderr).toBe("");
      expect(r.exitCode).toBe(0);
      const [toAllowed, toOther] = JSON.parse(r.stdout) as [string, string];
      expect(toAllowed).toBe("connected");
      expect(toOther).not.toBe("connected");
    });
  },
);

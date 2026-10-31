import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildBwrapArgv } from "./linux.ts";
import { buildForwarderArgv, HELPER_IN_SANDBOX, resolvConfTarget } from "./linux-forwarder.ts";
import { planForwardEntries } from "./net-forward-host.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV, type SandboxPolicy } from "./sandbox-policy.ts";

/**
 * The whole per-host path with nothing faked: the real `__nimbus-sandbox` wrapper and runner, the
 * real helper, nested `bwrap`, the real seccomp filter, and real listeners on the host's loopback
 * that a child reaches only as owner-configured `127.0.0.1:<port>` entries.
 *
 * Skipped unless the helper is built. CI's helper step and the restriction-on step set
 * NIMBUS_REQUIRE_SANDBOX_HELPER, which turns that skip into a failure.
 */
const HELPER = join(import.meta.dir, "../../../src-native/sandbox-helper/nimbus-sandbox-helper");
const GATEWAY_ENTRY = resolve(import.meta.dir, "../../index.ts");
const LINUX_MODULE = resolve(import.meta.dir, "linux.ts");
const IS_LINUX = process.platform === "linux";
const REQUIRED = process.env["NIMBUS_REQUIRE_SANDBOX_HELPER"] === "1";
/** Needs the internet, so a developer's offline run skips it. In CI a failure to reach it is red. */
const REAL_NETWORK =
  process.env["CI"] === "true" || process.env["NIMBUS_REQUIRE_REAL_NETWORK"] === "1";

const TEST_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 50_000;
const LEFTOVER_LIMIT_MS = 5000;
const FILE_READY_LIMIT_MS = 20_000;
const POLL_MS = 50;
const SINK_NAME = "sink.sock";
const ZERO_CAPS = "0000000000000000";
const FIRST_PARTY_WILDCARD = "*-run.googleapis.com";

const realExecPath = IS_LINUX ? realpathSync(process.execPath) : process.execPath;
const runtimeDir = dirname(realExecPath);

function helperBuilt(): boolean {
  if (!IS_LINUX || !existsSync(HELPER)) return false;
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const r = spawnSync(HELPER, ["--check"], { encoding: "utf8" });
  return r.status === 0 && r.stdout === "OK\n";
}

type Ran = { exitCode: number; stdout: string; stderr: string; elapsedMs: number };

function childProgram(body: string): string {
  return `
const net = require("node:net");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const report = (v) => { console.log(JSON.stringify(v)); };
const outcome = (host, port, ms = 3000) => new Promise((done) => {
  const s = net.connect({ host, port });
  const t = setTimeout(() => { s.destroy(); done("timeout"); }, ms);
  s.on("connect", () => { clearTimeout(t); s.destroy(); done("connected"); });
  s.on("error", (e) => { clearTimeout(t); done(e.code ?? "error"); });
});
const lookup = (name) => dns.lookup(name).then((a) => a.address, (e) => e.code);
const main = async () => { ${body} };
main().then(() => process.exit(0), (e) => { console.error(String(e)); process.exit(99); });
`;
}

type Sandbox = { cwd: string; socketParent: string };

function newSandbox(root: string, label: string): Sandbox {
  const base = mkdtempSync(join(root, `${label}-`));
  const cwd = join(base, "cwd");
  const socketParent = join(base, "run");
  mkdirSync(cwd);
  mkdirSync(socketParent);
  return { cwd, socketParent };
}

function policyOf(network: readonly string[], over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    id: "forwarder-network-test",
    permissions: {
      network: [...network],
      filesystem: { read: [runtimeDir], write: [] },
    },
    ...over,
  };
}

/** Owner-configured: the only trust that may reach the host's loopback. */
function ownerPolicy(network: readonly string[]): SandboxPolicy {
  return policyOf(network, { ownerConfiguredNetwork: [...network] });
}

function wrapperEnv(policy: SandboxPolicy, box: Sandbox): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: homedir(),
    XDG_RUNTIME_DIR: box.socketParent,
    NIMBUS_SANDBOX_HELPER_PATH: HELPER,
    [SANDBOX_POLICY_ENV]: JSON.stringify(policy),
    [SANDBOX_CWD_ENV]: box.cwd,
  };
}

function wrapperArgv(box: Sandbox, body: string, extra: readonly string[] = []): string[] {
  const script = join(box.cwd, "child.js");
  writeFileSync(script, childProgram(body));
  return [
    process.execPath,
    "--no-env-file",
    GATEWAY_ENTRY,
    "__nimbus-sandbox",
    realExecPath,
    "--no-env-file",
    script,
    ...extra,
  ];
}

/** Reading stdout and stderr to their ends is itself the EOF check: a held pipe hangs here. */
async function runChild(
  policy: SandboxPolicy,
  box: Sandbox,
  body: string,
  extra: readonly string[] = [],
): Promise<Ran> {
  const startedAt = Date.now();
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const proc = Bun.spawn(wrapperArgv(box, body, extra), {
    env: wrapperEnv(policy, box),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    elapsedMs: Date.now() - startedAt,
  };
}

function parseLast(stdout: string): Record<string, unknown> {
  const line = stdout.split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

async function reportOf(
  policy: SandboxPolicy,
  box: Sandbox,
  body: string,
): Promise<{ report: Record<string, unknown>; ran: Ran }> {
  const ran = await runChild(policy, box, body);
  if (ran.exitCode !== 0) {
    throw new Error(`child exit ${String(ran.exitCode)}: ${ran.stdout} ${ran.stderr}`);
  }
  return { report: parseLast(ran.stdout), ran };
}

async function until(what: string, check: () => boolean, limitMs: number): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

/** Every process whose command line carries `token`. The launcher's forwarder keeps its argv. */
function processesCarrying(token: string): { pid: number; cmdline: string[] }[] {
  const found: { pid: number; cmdline: string[] }[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || name === String(process.pid)) continue;
    try {
      const cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
      if (cmdline.includes(token)) found.push({ pid: Number(name), cmdline });
    } catch {
      // It exited while being read.
    }
  }
  return found;
}

function unixSink(path: string): Promise<{ server: Server; hits: () => number }> {
  let count = 0;
  const server = createServer((socket) => {
    count += 1;
    socket.destroy();
  });
  return new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(path, () => done({ server, hits: () => count }));
  });
}

describe.skipIf(!IS_LINUX || (!helperBuilt() && !REQUIRED))(
  "the Linux network forwarder, end to end",
  () => {
    let root = "";
    let http: ReturnType<typeof Bun.serve>;
    let silent: Server;
    let silentPort = 0;
    let silentHits = 0;
    let port = 0;
    let wsMessages = 0;

    beforeAll(async () => {
      expect(helperBuilt()).toBe(true);
      // Short: the socket path must fit in 107 bytes, and a test's runner may have a long TMPDIR.
      root = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "nf-net-")));
      http = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, server) {
          if (server.upgrade(req, { data: undefined })) return undefined;
          return new Response("from-the-host");
        },
        websocket: {
          message(ws, message) {
            wsMessages += 1;
            ws.send(String(message));
          },
        },
      });
      port = http.port ?? 0;
      // Never answers and never closes, and counts what reaches it.
      silent = createServer(() => {
        silentHits += 1;
      });
      await new Promise<void>((done) => {
        silent.listen(0, "127.0.0.1", () => done());
      });
      const address = silent.address();
      silentPort = typeof address === "object" && address !== null ? address.port : 0;
    });

    afterAll(() => {
      void http?.stop(true);
      silent?.close();
      rmSync(root, { recursive: true, force: true });
    });

    const declared = (): string => `127.0.0.1:${String(port)}`;

    describe("a declared entry", () => {
      test(
        "is reached by fetch, node:http, raw net.connect and a WebSocket, with no proxy set",
        async () => {
          const box = newSandbox(root, "reach");
          const { report } = await reportOf(
            ownerPolicy([declared()]),
            box,
            `
            const url = "http://127.0.0.1:${String(port)}/";
            const viaFetch = await fetch(url).then((r) => r.text());
            const viaHttp = await new Promise((done, fail) => {
              require("node:http").get(url, (res) => {
                let body = "";
                res.on("data", (d) => { body += d; });
                res.on("end", () => done(body));
              }).on("error", fail);
            });
            const viaNet = await new Promise((done, fail) => {
              const s = net.connect({ host: "127.0.0.1", port: ${String(port)} });
              let got = "";
              s.on("connect", () => s.write("GET / HTTP/1.0\\r\\nHost: x\\r\\n\\r\\n"));
              s.on("data", (d) => { got += d; });
              s.on("end", () => done(got));
              s.on("error", fail);
            });
            const viaWs = await new Promise((done, fail) => {
              const ws = new WebSocket("ws://127.0.0.1:${String(port)}/");
              ws.onopen = () => ws.send("ping");
              ws.onmessage = (m) => done(String(m.data));
              ws.onerror = () => fail(new Error("ws error"));
            });
            const proxied = Object.keys(process.env).filter((k) => /proxy/i.test(k));
            report({ viaFetch, viaHttp, viaNet: viaNet.includes("from-the-host"), viaWs, proxied });
          `,
          );
          expect(report).toEqual({
            viaFetch: "from-the-host",
            viaHttp: "from-the-host",
            viaNet: true,
            viaWs: "ping",
            proxied: [],
          });
          expect(wsMessages).toBeGreaterThan(0);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "written as localhost keeps working, and with a trailing dot",
        async () => {
          const box = newSandbox(root, "localhost");
          const entry = `localhost:${String(port)}`;
          const { report } = await reportOf(
            ownerPolicy([entry]),
            box,
            `report({
              hosts: fs.readFileSync("/etc/hosts", "utf8"),
              plain: await outcome("localhost", ${String(port)}),
              dotted: await outcome("localhost.", ${String(port)}),
              body: await fetch("http://localhost:${String(port)}/").then((r) => r.text()),
            });`,
          );
          expect(report).toEqual({
            hosts: "127.0.0.2 localhost localhost.\n",
            plain: "connected",
            dotted: "connected",
            body: "from-the-host",
          });
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a trailing-dot name and an underscore name resolve through the same entry",
        async () => {
          const box = newSandbox(root, "spelling");
          const { report } = await reportOf(
            policyOf(["jenkins.corp:8080", "my_jenkins:8081"]),
            box,
            `report({
              plain: await lookup("jenkins.corp"),
              dotted: await lookup("jenkins.corp."),
              upper: await lookup("JENKINS.corp"),
              underscore: await lookup("my_jenkins"),
              underscoreDotted: await lookup("my_jenkins."),
            });`,
          );
          expect(report).toEqual({
            plain: "127.0.0.2",
            dotted: "127.0.0.2",
            upper: "127.0.0.2",
            underscore: "127.0.0.3",
            underscoreDotted: "127.0.0.3",
          });
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "an IP literal outside loopback listens on its own address, and the child holds no capability",
        async () => {
          const box = newSandbox(root, "alias");
          // Nothing answers there, and that the run still ends shows a pending dial holds nothing.
          const { report } = await reportOf(
            ownerPolicy(["192.168.77.5:18080"]),
            box,
            `const caps = fs.readFileSync("/proc/self/status", "utf8");
             report({
               self: await outcome("192.168.77.5", 18080),
               neighbour: await outcome("192.168.77.6", 18080),
               otherPort: await outcome("192.168.77.5", 18081),
               capEff: caps.match(/^CapEff:\\s*(\\w+)/m)?.[1],
               capPrm: caps.match(/^CapPrm:\\s*(\\w+)/m)?.[1],
               capBnd: caps.match(/^CapBnd:\\s*(\\w+)/m)?.[1],
             });`,
          );
          expect(report["self"]).toBe("connected");
          expect(report["neighbour"]).not.toBe("connected");
          expect(report["otherPort"]).not.toBe("connected");
          expect(report["capEff"]).toBe(ZERO_CAPS);
          expect(report["capPrm"]).toBe(ZERO_CAPS);
          expect(report["capBnd"]).toBe(ZERO_CAPS);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("nothing else", () => {
      test(
        "not another port on that address, an undeclared name, a public IP, or DNS to 8.8.8.8",
        async () => {
          const box = newSandbox(root, "refuse");
          const hitsBefore = silentHits;
          const { report, ran } = await reportOf(
            ownerPolicy([declared()]),
            box,
            `
            const dgram = require("node:dgram");
            const udp = await new Promise((done) => {
              const s = dgram.createSocket("udp4");
              const t = setTimeout(() => { s.close(); done("no answer"); }, 1500);
              s.on("error", (e) => { clearTimeout(t); s.close(); done(e.code ?? "error"); });
              s.on("message", () => { clearTimeout(t); s.close(); done("ANSWERED"); });
              // A root NS query, so a resolver that was really reached would answer it.
              s.send(Buffer.from("000101000001000000000000000002000100", "hex"), 53, "8.8.8.8");
            });
            report({
              otherPort: await outcome("127.0.0.1", ${String(silentPort)}),
              undeclared: await lookup("undeclared-name.example"),
              publicIp: await outcome("1.1.1.1", 443),
              udp,
              resolvConf: fs.readFileSync("/etc/resolv.conf", "utf8"),
            });
          `,
          );
          expect(report["otherPort"]).toBe("ECONNREFUSED");
          expect(report["undeclared"]).toBe("ENOTFOUND");
          expect(report["publicIp"]).not.toBe("connected");
          expect(report["udp"]).not.toBe("ANSWERED");
          expect(report["resolvConf"]).toBe("nameserver 127.0.0.53\n");
          expect(silentHits).toBe(hitsBefore);
          // A refused lookup names the host, which is how a broken connector gets diagnosed.
          expect(ran.stderr).toContain("net-forward: undeclared-name.example: undeclared name");
          // A direct connection uses no name, so the wrapper and its log never see it.
          expect(ran.stderr).not.toContain("1.1.1.1");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a package-declared 127.0.0.1 is closed by the wrapper, and the log names it",
        async () => {
          const box = newSandbox(root, "package");
          const entry = `127.0.0.1:${String(silentPort)}`;
          const hitsBefore = silentHits;
          const { report, ran } = await reportOf(
            policyOf([entry]),
            box,
            `const result = await new Promise((done) => {
               const s = net.connect({ host: "127.0.0.1", port: ${String(silentPort)} });
               let opened = false;
               s.on("connect", () => { opened = true; s.write("x"); });
               s.on("data", () => done("DATA"));
               s.on("close", () => done(opened ? "closed" : "refused"));
               s.on("error", () => undefined);
             });
             report({ result });`,
          );
          expect(report["result"]).toBe("closed");
          await Bun.sleep(100);
          expect(silentHits).toBe(hitsBefore);
          expect(ran.stderr).toContain(`net-forward: ${entry}: refused address`);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a child with only a name declared cannot reach the host's loopback or a public address",
        async () => {
          const box = newSandbox(root, "no-route");
          const hitsBefore = silentHits;
          const { report } = await reportOf(
            policyOf(["a-declared-name.example:8443"]),
            box,
            `report({
              hostLoopback: await outcome("127.0.0.1", ${String(silentPort)}),
              publicIp: await outcome("1.1.1.1", 443),
              route: fs.readFileSync("/proc/net/route", "utf8").trim().split("\\n").length,
            });`,
          );
          expect(report["hostLoopback"]).toBe("ECONNREFUSED");
          expect(report["publicIp"]).not.toBe("connected");
          // The header alone: this namespace has no route anywhere.
          expect(report["route"]).toBe(1);
          expect(silentHits).toBe(hitsBefore);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a name with no entry that says localhost has no mapping to a dead address",
        async () => {
          const box = newSandbox(root, "no-localhost");
          const { report } = await reportOf(
            // A distro whose nsswitch has `myhostname`, as Fedora does, answers localhost itself, with
            // 127.0.0.1. So the proof is the file and the port, where no entry listens either way.
            ownerPolicy(["a-declared-name.example:8443"]),
            box,
            `report({
              hosts: fs.readFileSync("/etc/hosts", "utf8"),
              reach: await outcome("localhost", 8443),
            });`,
          );
          expect(report["hosts"]).toBe(
            "127.0.0.2 a-declared-name.example a-declared-name.example.\n",
          );
          expect(report["reach"]).not.toBe("connected");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "the child cannot see the socket, its directory or the helper",
        async () => {
          const box = newSandbox(root, "hidden");
          const { report } = await reportOf(
            ownerPolicy([declared()]),
            box,
            `report({
              // The mount point. The root column names where /etc/hosts came from, which reaches nothing.
              mounts: fs.readFileSync("/proc/self/mountinfo", "utf8").split("\\n").some((l) => (l.split(" ")[4] ?? "").startsWith(${JSON.stringify(box.socketParent)})),
              parent: fs.existsSync(${JSON.stringify(box.socketParent)}),
              helper: fs.existsSync(${JSON.stringify(HELPER_IN_SANDBOX)}),
              uid: process.getuid(),
              processes: fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d)).length,
            });`,
          );
          expect(report["mounts"]).toBe(false);
          expect(report["parent"]).toBe(false);
          expect(report["helper"]).toBe(false);
          expect(report["uid"]).toBe(process.getuid?.() ?? -1);
          // bwrap's pid 1 and the child: neither the launcher nor the forwarder is in this namespace.
          expect(report["processes"]).toBeLessThanOrEqual(2);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("the child's life", () => {
      test(
        "its exit code reaches the wrapper's caller, and the directory is removed",
        async () => {
          const box = newSandbox(root, "exit");
          const ran = await runChild(ownerPolicy([declared()]), box, "process.exit(7);");
          expect(ran.exitCode).toBe(7);
          expect(readdirSync(box.socketParent)).toEqual([]);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "its stdout closes when it exits, even with a connection open",
        async () => {
          const box = newSandbox(root, "eof");
          const ran = await runChild(
            ownerPolicy([`127.0.0.1:${String(silentPort)}`]),
            box,
            `await new Promise((done) => {
               const s = net.connect({ host: "127.0.0.1", port: ${String(silentPort)} });
               s.on("connect", () => { s.write("x"); setTimeout(done, 300); });
             });
             report({ opened: true });
             process.exit(4);`,
          );
          expect(ran.exitCode).toBe(4);
          expect(ran.stdout).toContain('"opened":true');
          // Far under the run timeout, which is what a held pipe would run into.
          expect(ran.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS - 10_000);
          expect(readdirSync(box.socketParent)).toEqual([]);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "it can spawn a subprocess and wait for it",
        async () => {
          const box = newSandbox(root, "subprocess");
          const { report } = await reportOf(
            ownerPolicy([declared()]),
            box,
            `const { spawn } = require("node:child_process");
             const code = await new Promise((done, fail) => {
               const c = spawn("/usr/bin/env", ["true"]);
               c.on("error", fail);
               c.on("exit", done);
             });
             report({ code });`,
          );
          expect(report["code"]).toBe(0);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a file it writes in its cwd belongs to the real uid on the host",
        async () => {
          const box = newSandbox(root, "owner");
          await reportOf(
            ownerPolicy([declared()]),
            box,
            `fs.writeFileSync("written.txt", "x"); report({ ok: true });`,
          );
          expect(statSync(join(box.cwd, "written.txt")).uid).toBe(process.getuid?.() ?? -1);
        },
        TEST_TIMEOUT_MS,
      );

      test.each<[string, "SIGKILL" | "SIGTERM"]>([
        ["killed outright", "SIGKILL"],
        ["stopped by a signal it can handle", "SIGTERM"],
      ])(
        "a wrapper %s leaves no child or forwarder within 5 s",
        async (_name, signal) => {
          const box = newSandbox(root, `kill-${signal}`);
          const token = `nimbus-forwarder-test-${signal}-${String(process.pid)}`;
          const marker = join(box.cwd, "ready");
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(
            wrapperArgv(
              box,
              `fs.writeFileSync("ready", "x"); await new Promise(() => setInterval(() => undefined, 1000));`,
              [token],
            ),
            {
              env: wrapperEnv(ownerPolicy([declared()]), box),
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
              timeout: RUN_TIMEOUT_MS,
            },
          );
          await until("the child to start", () => existsSync(marker), FILE_READY_LIMIT_MS);
          expect(processesCarrying(token).length).toBeGreaterThan(0);
          proc.kill(signal);
          await proc.exited;
          await until(
            "every sandbox process to be gone",
            () => processesCarrying(token).length === 0,
            LEFTOVER_LIMIT_MS,
          );
          // A signal it can handle also clears up. SIGKILL cannot, and leaves the small directory.
          if (signal === "SIGTERM") expect(readdirSync(box.socketParent)).toEqual([]);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "after the forwarder is killed, the next connection fails and nothing falls back",
        async () => {
          const box = newSandbox(root, "dead-forwarder");
          const token = `nimbus-forwarder-test-dead-${String(process.pid)}`;
          const ready = join(box.cwd, "ready");
          const go = join(box.cwd, "go");
          const body = `
            const before = await outcome("127.0.0.1", ${String(port)});
            const answered = await fetch("http://127.0.0.1:${String(port)}/").then((r) => r.status);
            fs.writeFileSync("ready", "x");
            while (!fs.existsSync("go")) await new Promise((r) => setTimeout(r, 50));
            const after = await fetch("http://127.0.0.1:${String(port)}/").then(
              (r) => "ANSWERED " + String(r.status),
              (e) => e.code ?? "failed",
            );
            report({
              before,
              answered,
              after,
              lookup: await Promise.race([
                lookup("undeclared-name.example"),
                new Promise((r) => setTimeout(() => r("no answer"), 3000)),
              ]),
              publicIp: await outcome("1.1.1.1", 443),
            });`;
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(wrapperArgv(box, body, [token]), {
            env: wrapperEnv(ownerPolicy([declared()]), box),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: RUN_TIMEOUT_MS,
          });
          await until("the first connection", () => existsSync(ready), FILE_READY_LIMIT_MS);
          // From the host. Its argv is still the launcher's, and relay children share it.
          const forwarders = processesCarrying(token).filter(
            (p) => p.cmdline[0] === HELPER_IN_SANDBOX,
          );
          expect(forwarders.length).toBeGreaterThan(0);
          for (const { pid } of forwarders) process.kill(pid, "SIGKILL");
          writeFileSync(go, "x");
          const [stdout, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            proc.exited,
          ]);
          expect(exitCode).toBe(0);
          const report = parseLast(stdout.trim());
          expect(report["before"]).toBe("connected");
          expect(report["answered"]).toBe(200);
          expect(String(report["after"])).not.toContain("ANSWERED");
          expect(report["lookup"]).not.toBe("127.0.0.1");
          expect(report["publicIp"]).not.toBe("connected");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "the wrapper does not wait for a dial pending on a blackholed address",
        async () => {
          const box = newSandbox(root, "pending-dial");
          // 192.0.2.0/24 is refused for everyone; an RFC 1918 literal the owner declared is dialed.
          const ran = await runChild(
            ownerPolicy(["10.255.255.1:18443"]),
            box,
            `await new Promise((done) => {
               const s = net.connect({ host: "10.255.255.1", port: 18443 });
               s.on("connect", () => setTimeout(done, 200));
             });
             process.exit(5);`,
          );
          expect(ran.exitCode).toBe(5);
          expect(ran.elapsedMs).toBeLessThan(RUN_TIMEOUT_MS - 10_000);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("the outer view", () => {
      /** The tail a compromised forwarder would be: a program run in the forwarder's exact view. */
      function outerViewArgv(
        policy: SandboxPolicy,
        box: Sandbox,
        socketDir: string,
        program: readonly string[],
      ): string[] {
        const target = resolvConfTarget();
        const hostsFile = join(socketDir, "hosts");
        const resolvFile = join(socketDir, "resolv.conf");
        writeFileSync(hostsFile, "");
        writeFileSync(resolvFile, "");
        const argv = buildForwarderArgv(policy, {
          cwd: box.cwd,
          helperPath: HELPER,
          socketDir,
          hostsFile,
          resolvFile,
          resolvConfTarget: target,
          entries: planForwardEntries(policy),
          innerArgv: [
            "/usr/bin/bwrap",
            ...buildBwrapArgv(policy, { mode: "per-host", cwd: box.cwd }),
          ],
        });
        return [
          ...argv.slice(0, argv.indexOf(HELPER_IN_SANDBOX, argv.indexOf("--chdir"))),
          ...program,
        ];
      }

      const CONNECT_ALL = `
        const net = require("node:net");
        const attempt = (path) => new Promise((done) => {
          const s = net.connect(path);
          s.on("connect", () => { s.destroy(); done("connected"); });
          s.on("error", (e) => done(e.code ?? "error"));
        });
        const out = {};
        for (const path of process.argv.slice(2)) out[path] = await attempt(path);
        console.log(JSON.stringify(out));
        process.exit(0);
      `;

      test(
        "a unix socket outside the policy gets nothing, and the view's own socket proves the probe works",
        async () => {
          const box = newSandbox(root, "outer");
          const socketDir = mkdtempSync(join(root, "s-"));
          const own = await unixSink(join(socketDir, SINK_NAME));
          const inTmp = mkdtempSync(join(root, "outside-"));
          const tmpSink = await unixSink(join(inTmp, SINK_NAME));
          const inHome = mkdtempSync(join(homedir(), ".nimbus-forwarder-test-"));
          const homeSink = await unixSink(join(inHome, SINK_NAME));
          try {
            const script = join(box.cwd, "connect.js");
            writeFileSync(script, CONNECT_ALL);
            const policy = ownerPolicy([declared()]);
            const argv = outerViewArgv(policy, box, socketDir, [
              realExecPath,
              "--no-env-file",
              script,
              join(socketDir, SINK_NAME),
              join(inTmp, SINK_NAME),
              join(inHome, SINK_NAME),
              "/run/dbus/system_bus_socket",
            ]);
            // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
            const proc = Bun.spawn(["/usr/bin/bwrap", ...argv], {
              env: { PATH: "/usr/bin:/bin" },
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              timeout: RUN_TIMEOUT_MS,
            });
            const [stdout, stderr, code] = await Promise.all([
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
              proc.exited,
            ]);
            if (code !== 0) throw new Error(`exit ${String(code)}: ${stderr}`);
            const out = JSON.parse(stdout.trim()) as Record<string, string>;
            expect(out[join(socketDir, SINK_NAME)]).toBe("connected");
            expect(own.hits()).toBe(1);
            expect(out[join(inTmp, SINK_NAME)]).not.toBe("connected");
            expect(out[join(inHome, SINK_NAME)]).not.toBe("connected");
            expect(out["/run/dbus/system_bus_socket"]).not.toBe("connected");
            expect(tmpSink.hits()).toBe(0);
            expect(homeSink.hits()).toBe(0);
          } finally {
            own.server.close();
            tmpSink.server.close();
            homeSink.server.close();
            rmSync(inHome, { recursive: true, force: true });
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("the start probe", () => {
      type ProbeAnswer = { active: boolean; reason: string | null; canConfine: string | null };

      async function probeWith(helperPath: string, extraEnv = {}): Promise<ProbeAnswer> {
        const script = join(mkdtempSync(join(root, "probe-")), "probe.ts");
        writeFileSync(
          script,
          `import { createLinuxSandboxRunner } from ${JSON.stringify(LINUX_MODULE)};
           const runner = createLinuxSandboxRunner();
           await runner.probeForwarderStart();
           console.log(JSON.stringify({
             active: runner.isFullyActive(),
             reason: runner.degradedReason(),
             canConfine: runner.canConfine({
               id: "p",
               permissions: { network: ["a.example.com"], filesystem: { read: [], write: [] } },
             }),
           }));
           process.exit(0);`,
        );
        // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
        const proc = Bun.spawn([process.execPath, "--no-env-file", script], {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: homedir(),
            NIMBUS_SANDBOX_HELPER_PATH: helperPath,
            ...extraEnv,
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: RUN_TIMEOUT_MS,
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const line = stdout.trim().split("\n").at(-1);
        if (line === undefined || line === "") throw new Error(`no answer: ${stderr}`);
        return JSON.parse(line) as ProbeAnswer;
      }

      function stubHelper(body: string): string {
        const path = join(mkdtempSync(join(root, "stub-")), "helper");
        writeFileSync(
          path,
          `#!/usr/bin/sh\nif [ "$1" = "--check" ]; then echo OK; exit 0; fi\n${body}\n`,
        );
        chmodSync(path, 0o755);
        return path;
      }

      test(
        "a real start with a real connection answers yes",
        async () => {
          expect(await probeWith(HELPER)).toEqual({ active: true, reason: null, canConfine: null });
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a forwarder that failed lockdown, which is exit 6, refuses",
        async () => {
          const answer = await probeWith(stubHelper("exit 6"));
          expect(answer.active).toBe(false);
          expect(answer.reason).toContain("exit 6");
          expect(answer.canConfine).toContain("exit 6");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a child that gets no answer through the forwarder refuses",
        async () => {
          const answer = await probeWith(stubHelper("exit 8"));
          expect(answer.active).toBe(false);
          expect(answer.canConfine).toContain("exit 8");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a helper that is present and hangs is bounded and refuses, rather than falling back",
        async () => {
          // Waits on its own: the probe's timeout is the only thing that can end this.
          const answer = await probeWith(stubHelper("while :; do /usr/bin/sleep 1; done"));
          expect(answer.active).toBe(false);
          expect(answer.canConfine).toContain("did not finish");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a missing helper keeps the documented refusal, and no start is attempted",
        async () => {
          const answer = await probeWith(join(root, "no-such-helper"));
          expect(answer.active).toBe(false);
          expect(answer.reason).toContain("not found");
          expect(answer.canConfine).toContain("not found");
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("the spawn refuses", () => {
      async function wrapperRefusal(policy: SandboxPolicy, label: string): Promise<Ran> {
        const box = newSandbox(root, label);
        const ran = await runChild(policy, box, "process.exit(0);");
        expect(readdirSync(box.socketParent)).toEqual([]);
        return ran;
      }

      test(
        "a 253rd host",
        async () => {
          const network = Array.from({ length: 253 }, (_v, i) => `h${String(i)}.example.com`);
          const ran = await wrapperRefusal(policyOf(network), "too-many");
          expect(ran.exitCode).toBe(2);
          expect(ran.stderr).toContain("at most 252");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "wildcards without a first-party policy",
        async () => {
          const ran = await wrapperRefusal(
            policyOf([], { firstPartyWildcardHosts: [FIRST_PARTY_WILDCARD] }),
            "not-first-party",
          );
          expect(ran.exitCode).toBe(2);
          expect(ran.stderr).toContain("first-party");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a policy path that would show the forwarder the runtime directory",
        async () => {
          const ran = await wrapperRefusal(
            policyOf(["a.example.com"], {
              permissions: {
                network: ["a.example.com"],
                filesystem: { read: ["/run"], write: [] },
              },
            }),
            "wide",
          );
          expect(ran.exitCode).toBe(2);
          expect(ran.stderr).toContain("runtime directory");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a helper that is there and fails its check, and never falls back to the host network",
        async () => {
          const box = newSandbox(root, "bad-helper");
          const broken = join(mkdtempSync(join(root, "broken-")), "helper");
          writeFileSync(broken, "#!/usr/bin/sh\nexit 1\n");
          chmodSync(broken, 0o755);
          const env = { ...wrapperEnv(policyOf(["a.example.com"]), box) };
          env["NIMBUS_SANDBOX_HELPER_PATH"] = broken;
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(wrapperArgv(box, "process.exit(0);"), {
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout: RUN_TIMEOUT_MS,
          });
          const [stderr, exitCode] = await Promise.all([
            new Response(proc.stderr).text(),
            proc.exited,
          ]);
          expect(exitCode).toBe(2);
          expect(stderr).toContain("refusing to spawn");
          expect(stderr).toContain("--check failed");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a start bwrap cannot make: the child's exit carries it, and the directory still goes",
        async () => {
          const ran = await wrapperRefusal(
            policyOf(["a.example.com"], {
              permissions: {
                network: ["a.example.com"],
                filesystem: { read: [join(root, "does-not-exist")], write: [] },
              },
            }),
            "bad-bind",
          );
          expect(ran.exitCode).not.toBe(0);
          expect(ran.stderr).toContain("does-not-exist");
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("first-party wildcard hosts", () => {
      const wildcardPolicy = (network: readonly string[]): SandboxPolicy =>
        policyOf(network, {
          firstPartyPolicy: true,
          firstPartyWildcardHosts: [FIRST_PARTY_WILDCARD],
        });

      test(
        "with no exact entry, a matching name gets a slot and others are refused by name",
        async () => {
          const box = newSandbox(root, "wildcard");
          const { report, ran } = await reportOf(
            wildcardPolicy([]),
            box,
            `const a = await lookup("us-central1-run.googleapis.com");
             report({
               a,
               again: await lookup("us-central1-run.googleapis.com"),
               other: await lookup("europe-west1-run.googleapis.com"),
               evil: await lookup("evil.googleapis.com"),
               twoLabels: await lookup("a.b-run.googleapis.com"),
               hosts: fs.readFileSync("/etc/hosts", "utf8"),
             });`,
          );
          expect(report["a"]).toMatch(/^127\.0\.0\.\d+$/);
          expect(report["again"]).toBe(report["a"]);
          expect(report["other"]).toMatch(/^127\.0\.0\.\d+$/);
          expect(report["other"]).not.toBe(report["a"]);
          expect(report["evil"]).toBe("ENOTFOUND");
          expect(report["twoLabels"]).toBe("ENOTFOUND");
          expect(report["hosts"]).toBe("");
          expect(ran.stderr).toContain("evil.googleapis.com");
          expect(ran.stderr).toContain("a.b-run.googleapis.com");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "252 exact entries leave no pool: a matching name fails, and the log says the pool is full",
        async () => {
          const box = newSandbox(root, "no-pool");
          const network = Array.from({ length: 252 }, (_v, i) => `h${String(i)}.example.com`);
          const { report, ran } = await reportOf(
            wildcardPolicy(network),
            box,
            `report({
               exact: await lookup("h251.example.com"),
               wild: await lookup("us-central1-run.googleapis.com"),
             });`,
          );
          expect(report["exact"]).toMatch(/^127\.0\.0\.\d+$/);
          expect(report["wild"]).not.toMatch(/^127\./);
          expect(ran.stderr).toContain("wildcard pool full");
        },
        TEST_TIMEOUT_MS,
      );

      test.skipIf(!REAL_NETWORK)(
        "real network: a matching name reaches its host over real TLS, and others fail to resolve",
        async () => {
          const box = newSandbox(root, "real");
          const { report, ran } = await reportOf(
            wildcardPolicy([]),
            box,
            `report({
               status: await fetch("https://us-central1-run.googleapis.com/").then((r) => r.status),
               evil: await fetch("https://evil.googleapis.com/").then((r) => r.status, (e) => e.code ?? "failed"),
               twoLabels: await fetch("https://a.b-run.googleapis.com/").then((r) => r.status, (e) => e.code ?? "failed"),
             });`,
          );
          expect(typeof report["status"]).toBe("number");
          expect(typeof report["evil"]).not.toBe("number");
          expect(typeof report["twoLabels"]).not.toBe("number");
          expect(ran.stderr).toContain("evil.googleapis.com");
          expect(ran.stderr).toContain("a.b-run.googleapis.com");
        },
        TEST_TIMEOUT_MS,
      );
    });
  },
);

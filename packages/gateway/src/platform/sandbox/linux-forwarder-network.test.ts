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
import { wrapServerSpecInCwd } from "../../connectors/lazy-mesh/wrap-server-spec.ts";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { buildBwrapArgv } from "./linux.ts";
import { buildForwarderArgv, HELPER_IN_SANDBOX, resolvConfTarget } from "./linux-forwarder.ts";
import { planForwardEntries } from "./net-forward-host.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * The whole per-host path with nothing faked: the real `__nimbus-sandbox` wrapper and runner, the
 * real helper, nested `bwrap`, the real seccomp filter, and real listeners on the host's loopback
 * that a child reaches only as owner-configured `127.0.0.1:<port>` entries.
 *
 * Each child starts the way a real one does, through `wrapServerSpecInCwd` with the environment
 * `extensionProcessEnv` builds. A hand-written wrapper environment here once hid that the wrapper
 * never received the helper override, so a child got the whole internet while this file stayed green.
 *
 * Skipped unless the helper is built. CI's restriction-on step sets NIMBUS_REQUIRE_SANDBOX_HELPER,
 * which turns that skip into a failure, and is the one step that runs this file: it needs the internet
 * for one test, and a run with the restriction off would prove nothing more.
 */
const HELPER = join(import.meta.dir, "../../../src-native/sandbox-helper/nimbus-sandbox-helper");
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

const NO_CORE_THEN_EXEC = 'ulimit -c 0; exec "$0" "$@"';
/** 128 + SIGSYS: how the filter's kill shows at the wrapper. */
const SECCOMP_KILLED_EXIT = 159;
const REAL_NETWORK_URL = "https://us-central1-run.googleapis.com/";
const HOST_REACH_TIMEOUT_MS = 15_000;

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

/** The fields `policyFromManifest` reads. Nothing here looks at the rest of a manifest. */
function manifestOf(policy: SandboxPolicy): ExtensionManifest {
  return { ...policy } as unknown as ExtensionManifest;
}

type Wrapped = { argv: string[]; env: Record<string, string> };

/** What the gateway would spawn for this child, given a gateway with this helper and runtime dir. */
function wrapped(
  policy: SandboxPolicy,
  box: Sandbox,
  body: string,
  extra: readonly string[] = [],
  opts: { coreless?: boolean } = {},
): Wrapped {
  const script = join(box.cwd, "child.js");
  writeFileSync(script, childProgram(body));
  const saved = {
    helper: process.env["NIMBUS_SANDBOX_HELPER_PATH"],
    runtime: process.env["XDG_RUNTIME_DIR"],
  };
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = HELPER;
  process.env["XDG_RUNTIME_DIR"] = box.socketParent;
  try {
    const child = [realExecPath, "--no-env-file", script, ...extra];
    // A seccomp kill dumps Bun's core first, which takes 16 s and proves nothing more.
    const argv =
      opts.coreless === true ? ["/usr/bin/sh", "-c", NO_CORE_THEN_EXEC, ...child] : child;
    const spec = wrapServerSpecInCwd(
      { command: argv[0] ?? "", args: argv.slice(1), env: extensionProcessEnv({}) },
      manifestOf(policy),
      box.cwd,
    );
    return { argv: [spec.command, ...spec.args], env: spec.env };
  } finally {
    restoreEnv("NIMBUS_SANDBOX_HELPER_PATH", saved.helper);
    restoreEnv("XDG_RUNTIME_DIR", saved.runtime);
  }
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Reading stdout and stderr to their ends is itself the EOF check: a held pipe hangs here. */
async function runChild(
  policy: SandboxPolicy,
  box: Sandbox,
  body: string,
  extra: readonly string[] = [],
  opts: { coreless?: boolean } = {},
): Promise<Ran> {
  const startedAt = Date.now();
  const spawned = wrapped(policy, box, body, extra, opts);
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const proc = Bun.spawn(spawned.argv, {
    env: spawned.env,
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
        "with no entry naming localhost, it means this namespace: a child can listen there, and the host's listener is not reached",
        async () => {
          const box = newSandbox(root, "no-localhost");
          const hitsBefore = silentHits;
          const { report } = await reportOf(
            ownerPolicy(["a-declared-name.example:8443"]),
            box,
            `const own = await new Promise((done, fail) => {
               const server = net.createServer((s) => s.end("own"));
               server.on("error", fail);
               server.listen(0, "localhost", () => {
                 const c = net.connect({ host: "localhost", port: server.address().port });
                 let got = "";
                 c.on("data", (d) => { got += d; });
                 c.on("end", () => done(got));
                 c.on("error", fail);
               });
             });
             report({
               hosts: fs.readFileSync("/etc/hosts", "utf8"),
               own,
               hostListener: await outcome("localhost", ${String(silentPort)}),
             });`,
          );
          expect(report["hosts"]).toBe(
            "127.0.0.1 localhost localhost.\n127.0.0.2 a-declared-name.example a-declared-name.example.\n",
          );
          expect(report["own"]).toBe("own");
          // A real listener on the host's own loopback, at that port.
          expect(report["hostListener"]).toBe("ECONNREFUSED");
          expect(silentHits).toBe(hitsBefore);
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
          const spawned = wrapped(
            ownerPolicy([declared()]),
            box,
            `fs.writeFileSync("ready", "x"); await new Promise(() => setInterval(() => undefined, 1000));`,
            [token],
          );
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(spawned.argv, {
            env: spawned.env,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            timeout: RUN_TIMEOUT_MS,
          });
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
          const spawned = wrapped(ownerPolicy([declared()]), box, body, [token]);
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(spawned.argv, {
            env: spawned.env,
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

    describe("the way a real child starts", () => {
      test(
        "through wrapServerSpec, the child has no route, and neither wrapper-only variable",
        async () => {
          const box = newSandbox(root, "wrapped");
          const { report } = await reportOf(
            policyOf(["a-declared-name.example:8443"]),
            box,
            `report({
              routeLines: fs.readFileSync("/proc/net/route", "utf8").trim().split("\\n").length,
              helper: process.env.NIMBUS_SANDBOX_HELPER_PATH ?? null,
              runtime: process.env.XDG_RUNTIME_DIR ?? null,
              policy: process.env.NIMBUS_SANDBOX_POLICY_JSON ?? null,
            });`,
          );
          expect(report).toEqual({ routeLines: 1, helper: null, runtime: null, policy: null });
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("what the child's filter lets an ordinary program do", () => {
      /** A raw syscall from the child, for the calls no JavaScript API makes on its own. */
      const SYSCALL = `const { dlopen } = require("bun:ffi");
        const libc = dlopen("libc.so.6", { syscall: { args: ["i64", "i64", "i64", "i64"], returns: "i64" } }).symbols;
        const sys = (nr, a = 0, b = 0, c = 0) => Number(libc.syscall(nr, a, b, c));`;
      const SYS_GETTID = 186;

      const ALLOWED: readonly [string, string, unknown][] = [
        [
          "child.kill(), which is kill",
          `const c = require("node:child_process").spawn("/usr/bin/sleep", ["30"]);
           await new Promise((r) => c.once("spawn", r));
           c.kill();
           report({ v: await new Promise((r) => c.once("exit", (_code, signal) => r(signal))) });`,
          "SIGTERM",
        ],
        ["process.kill(pid, 0)", `report({ v: process.kill(process.pid, 0) });`, true],
        ["tkill", `${SYSCALL} report({ v: sys(200, sys(${String(SYS_GETTID)}), 0) });`, 0],
        [
          "fsync",
          `const fd = fs.openSync("f", "w"); fs.fsyncSync(fd); fs.closeSync(fd); report({ v: "ok" });`,
          "ok",
        ],
        [
          "fdatasync",
          `const fd = fs.openSync("f", "w"); fs.fdatasyncSync(fd); fs.closeSync(fd); report({ v: "ok" });`,
          "ok",
        ],
        ["umask", `process.umask(0o077); report({ v: process.umask() });`, 0o077],
        [
          "setsid, through detached: true",
          `const c = require("node:child_process").spawn("/usr/bin/sh", ["-c", "exit 3"], { detached: true });
           report({ v: await new Promise((r) => c.once("exit", r)) });`,
          3,
        ],
        ["setpgid", `${SYSCALL} report({ v: sys(109, 0, 0) });`, 0],
        [
          "faccessat2, which survives its bad pointer",
          `${SYSCALL} report({ v: sys(439, -100, 0, 0) });`,
          -1,
        ],
        [
          "fadvise64, which survives its bad descriptor",
          `${SYSCALL} report({ v: sys(221, -1, 0, 0) });`,
          -1,
        ],
        ["getpgid", `${SYSCALL} report({ v: sys(121, 0) > 0 });`, true],
        ["getsid", `${SYSCALL} report({ v: sys(124, 0) > 0 });`, true],
        ["getgroups", `${SYSCALL} report({ v: sys(115, 0, 0) >= 0 });`, true],
        [
          "getresuid, which survives its bad pointers",
          `${SYSCALL} report({ v: sys(118, 0, 0, 0) });`,
          -1,
        ],
        [
          "getresgid, which survives its bad pointers",
          `${SYSCALL} report({ v: sys(120, 0, 0, 0) });`,
          -1,
        ],
        ["sched_getscheduler", `${SYSCALL} report({ v: sys(145, 0) >= 0 });`, true],
        // Added with the ENOSYS default. Each is called with arguments that make a real kernel
        // answer something other than ENOSYS, so a pass means the filter let it through.
        [
          "flock, which survives its bad descriptor",
          `${SYSCALL} report({ v: sys(73, -1, 8) });`,
          -1,
        ],
        ["gettimeofday", `${SYSCALL} report({ v: sys(96, 0, 0) });`, 0],
        ["getpriority", `${SYSCALL} report({ v: sys(140, 0, 0) >= 0 });`, true],
        ["capget, which survives its null header", `${SYSCALL} report({ v: sys(125, 0, 0) });`, -1],
        [
          "sched_getparam, which survives its null pointer",
          `${SYSCALL} report({ v: sys(143, 0, 0) });`,
          -1,
        ],
        ["alarm, cancelling nothing", `${SYSCALL} report({ v: sys(37, 0) });`, 0],
        [
          "/bin/sh -c, as a shell-script CLI starts",
          `const c = require("node:child_process").spawnSync("/bin/sh", ["-c", "echo from-sh"], { encoding: "utf8" });
           report({ v: c.stdout.trim() });`,
          "from-sh",
        ],
        [
          "a node:child_process spawn, which falls back from clone3 to clone",
          `const c = require("node:child_process").spawnSync("/usr/bin/sh", ["-c", "echo from-spawn"], { encoding: "utf8" });
           report({ v: c.stdout.trim() });`,
          "from-spawn",
        ],
        [
          "a Bun.spawn",
          `const p = Bun.spawn(["/usr/bin/sh", "-c", "echo from-bun-spawn"], { stdout: "pipe" });
           report({ v: (await new Response(p.stdout).text()).trim() });`,
          "from-bun-spawn",
        ],
        [
          "a worker thread, which is a clone with thread flags",
          `const path = require("node:path").resolve("worker.js");
           fs.writeFileSync(path, "postMessage('from-worker');");
           const w = new Worker(path);
           report({ v: await new Promise((done, fail) => { w.onmessage = (m) => done(m.data); w.onerror = (e) => fail(new Error(String(e.message))); }) });
           w.terminate();`,
          "from-worker",
        ],
        [
          "clone3 answering ENOSYS rather than killing",
          `${SYSCALL}
           const { read } = require("bun:ffi");
           const e = dlopen("libc.so.6", { __errno_location: { args: [], returns: "ptr" } }).symbols;
           const first = sys(435, 0, 0);
           report({ v: [first, read.i32(e.__errno_location())] });`,
          [-1, 38],
        ],
        [
          "a shell's own pipeline and job control",
          `const c = require("node:child_process").spawnSync("/bin/sh", ["-c", "set -m; (exit 4) & wait $!; echo $?"], { encoding: "utf8" });
           report({ v: c.stdout.trim() });`,
          "4",
        ],
      ];

      test.each(ALLOWED)(
        "%s",
        async (name, body, expected) => {
          const box = newSandbox(root, `allow-${name.replaceAll(/[^a-z]/g, "").slice(0, 12)}`);
          const ran = await runChild(ownerPolicy([declared()]), box, body, [], { coreless: true });
          expect(ran.exitCode).toBe(0);
          expect(parseLast(ran.stdout)["v"]).toEqual(expected);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "/bin/sh works in the no-network mode too",
        async () => {
          const box = newSandbox(root, "allow-nonet");
          const ran = await runChild(
            policyOf([]),
            box,
            `const c = require("node:child_process").spawnSync("/bin/sh", ["-c", "echo from-sh"], { encoding: "utf8" });
             report({ v: c.stdout.trim() });`,
            [],
            { coreless: true },
          );
          expect(ran.exitCode).toBe(0);
          expect(parseLast(ran.stdout)["v"]).toBe("from-sh");
        },
        TEST_TIMEOUT_MS,
      );

      test.each<[string, number]>([
        ["pidfd_getfd", 438],
        ["pidfd_send_signal", 424],
        ["setns", 308],
        ["unshare", 272],
      ])(
        "%s stays killed",
        async (_name, nr) => {
          const box = newSandbox(root, "killed");
          const ran = await runChild(
            ownerPolicy([declared()]),
            box,
            `${SYSCALL} report({ survived: true, v: sys(${String(nr)}) });`,
            [],
            { coreless: true },
          );
          expect(ran.exitCode).toBe(SECCOMP_KILLED_EXIT);
          expect(ran.stdout).not.toContain("survived");
        },
        TEST_TIMEOUT_MS,
      );

      test.each<[string, number]>([
        ["CLONE_NEWUSER", 0x10000000],
        ["CLONE_NEWNET", 0x40000000],
        ["CLONE_NEWNS", 0x00020000],
        ["CLONE_NEWPID", 0x20000000],
        ["CLONE_NEWIPC", 0x08000000],
        ["CLONE_NEWUTS", 0x04000000],
        ["CLONE_NEWCGROUP", 0x02000000],
        ["CLONE_NEWTIME", 0x00000080],
      ])(
        "clone(%s) is killed, as unshare is",
        async (_name, flag) => {
          const box = newSandbox(root, "clone-ns");
          const ran = await runChild(
            ownerPolicy([declared()]),
            box,
            `${SYSCALL} report({ survived: true, v: sys(56, ${String(flag)}) });`,
            [],
            { coreless: true },
          );
          expect(ran.exitCode).toBe(SECCOMP_KILLED_EXIT);
          expect(ran.stdout).not.toContain("survived");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "an unlisted call answers ENOSYS and the child keeps running",
        async () => {
          const box = newSandbox(root, "enosys");
          const ran = await runChild(
            ownerPolicy([declared()]),
            box,
            `${SYSCALL}
             const { read } = require("bun:ffi");
             const e = dlopen("libc.so.6", { __errno_location: { args: [], returns: "ptr" } }).symbols;
             const first = sys(319, 0, 0); // memfd_create with a null name
             const errno = read.i32(e.__errno_location());
             report({ first, errno });
             report({ after: "still running", pid: process.pid > 0 });`,
            [],
            { coreless: true },
          );
          expect(ran.exitCode).toBe(0);
          expect(parseLast(ran.stdout)["after"]).toBe("still running");
          const first = ran.stdout.split("\n").find((l) => l.includes("errno"));
          expect(JSON.parse(first ?? "{}")).toEqual({ first: -1, errno: 38 });
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "ptrace stays refused, with EPERM rather than a kill",
        async () => {
          const box = newSandbox(root, "ptrace");
          const ran = await runChild(
            ownerPolicy([declared()]),
            box,
            `${SYSCALL} report({ v: sys(101, 0, process.ppid) });`,
            [],
            { coreless: true },
          );
          expect(ran.exitCode).toBe(0);
          expect(parseLast(ran.stdout)["v"]).toBe(-1);
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
      type ProbeAnswer = {
        active: boolean;
        reason: string | null;
        canConfine: string | null;
        badName: string | null;
      };

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
             badName: runner.canConfine({
               id: "p",
               permissions: { network: ["bad name.example.com"], filesystem: { read: [], write: [] } },
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
          const answer = await probeWith(HELPER);
          expect(answer).toMatchObject({ active: true, reason: null, canConfine: null });
          // What the spawn would refuse, it refuses here too.
          expect(answer.badName).toContain("/etc/hosts");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a start reporting exit 6 is reported and refused (a stub, so this proves the reporting; the launcher's own exit 6 is in linux-helper-launcher.test.ts)",
        async () => {
          const answer = await probeWith(stubHelper("exit 6"));
          expect(answer.active).toBe(false);
          expect(answer.reason).toContain("exit 6");
          expect(answer.canConfine).toContain("exit 6");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a start reporting exit 8 is reported and refused (a stub, so this proves the reporting)",
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
        "a helper that hangs on --check is bounded, and is refused as present",
        async () => {
          const hanging = join(mkdtempSync(join(root, "stub-")), "helper");
          writeFileSync(hanging, "#!/usr/bin/sh\nexec /usr/bin/sleep 60\n");
          chmodSync(hanging, 0o755);
          const startedAt = Date.now();
          const answer = await probeWith(hanging);
          expect(Date.now() - startedAt).toBeLessThan(30_000);
          expect(answer.active).toBe(false);
          expect(answer.canConfine).toContain("--check failed");
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a start that timed out is not kept: it is asked again in the background, one at a time",
        async () => {
          const dir = mkdtempSync(join(root, "retry-"));
          const hang = join(dir, "hang");
          const count = join(dir, "count");
          writeFileSync(hang, "");
          const stub = join(dir, "helper");
          // Every start appends a line, so the count is the number of starts.
          writeFileSync(
            stub,
            `#!/usr/bin/sh\nif [ "$1" = "--check" ]; then echo OK; exit 0; fi\nexit 0\n`,
          );
          chmodSync(stub, 0o755);
          const bwrap = join(dir, "bwrap");
          writeFileSync(
            bwrap,
            // Only the forwarder's start is counted and hangs. The runner's own bwrap checks pass.
            `#!/bin/sh\ncase "$*" in *--socket*) ;; *) exit 0 ;; esac\necho x >> ${count}\nif [ -e ${hang} ]; then exec /usr/bin/sleep 60; fi\nexit 0\n`,
          );
          chmodSync(bwrap, 0o755);
          const script = join(dir, "retry.ts");
          writeFileSync(
            script,
            `import { readFileSync, rmSync } from "node:fs";
             import { createLinuxSandboxRunner } from ${JSON.stringify(LINUX_MODULE)};
             const policy = { id: "p", permissions: { network: ["a.example.com"], filesystem: { read: [], write: [] } } };
             const runner = createLinuxSandboxRunner({ startProbeTimeoutMs: 300 });
             await runner.probeForwarderStart();
             const first = runner.canConfine(policy);
             // Many asks while a retry hangs must start only that one.
             for (let i = 0; i < 20; i += 1) {
               runner.isFullyActive();
               await Bun.sleep(10);
             }
             const starts = () => readFileSync(${JSON.stringify(count)}, "utf8").trim().split("\\n").length;
             while (starts() < 2) {
               runner.isFullyActive();
               await Bun.sleep(20);
             }
             rmSync(${JSON.stringify(hang)});
             await Bun.sleep(1000);
             const second = runner.canConfine(policy);
             await Bun.sleep(1000);
             const third = runner.canConfine(policy);
             console.log(JSON.stringify({ first, second, third }));
             process.exit(0);`,
          );
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn([process.execPath, "--no-env-file", script], {
            env: {
              PATH: "/usr/bin:/bin",
              HOME: homedir(),
              NIMBUS_SANDBOX_HELPER_PATH: stub,
              NIMBUS_BWRAP_PATH: bwrap,
            },
            stdout: "pipe",
            stderr: "pipe",
            timeout: RUN_TIMEOUT_MS,
          });
          const stdout = await new Response(proc.stdout).text();
          await proc.exited;
          const out = parseLast(stdout.trim());
          expect(String(out["first"])).toContain("did not finish");
          expect(out["third"]).toBeNull();
          // Far fewer starts than the 20 asks, since each hangs for its whole 300 ms bound.
          expect(readFileSync(count, "utf8").trim().split("\n").length).toBeLessThanOrEqual(6);
        },
        TEST_TIMEOUT_MS,
      );

      test(
        "a runner leaves no seccomp directory behind when its process exits",
        async () => {
          const tmp = mkdtempSync(join(root, "seccomp-"));
          const script = join(tmp, "make.ts");
          writeFileSync(
            script,
            `import { createLinuxSandboxRunner } from ${JSON.stringify(LINUX_MODULE)};
             createLinuxSandboxRunner();
             createLinuxSandboxRunner();
             process.exit(0);`,
          );
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn([process.execPath, "--no-env-file", script], {
            env: { PATH: "/usr/bin:/bin", HOME: homedir(), TMPDIR: tmp },
            stdout: "ignore",
            stderr: "ignore",
            timeout: RUN_TIMEOUT_MS,
          });
          await proc.exited;
          expect(readdirSync(tmp).filter((name) => name.startsWith("nimbus-sandbox-"))).toEqual([]);
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

    describe("a helper override that names nothing", () => {
      test(
        "refuses a network child in canConfine and spawn, never falling back to the host network",
        async () => {
          const script = join(mkdtempSync(join(root, "typo-")), "typo.ts");
          writeFileSync(
            script,
            `import { createLinuxSandboxRunner } from ${JSON.stringify(LINUX_MODULE)};
             const runner = createLinuxSandboxRunner();
             const net = { id: "p", permissions: { network: ["a.example.com"], filesystem: { read: [], write: [] } } };
             const none = { id: "q", permissions: { network: [], filesystem: { read: [], write: [] } } };
             let spawned = "no throw";
             try {
               const c = runner.spawn("/usr/bin/true", [], { policy: net, cwd: "/tmp", stdio: "ignore" });
               c.kill();
             } catch (e) { spawned = String(e instanceof Error ? e.message : e); }
             console.log(JSON.stringify({
               canConfine: runner.canConfine(net),
               noNet: runner.canConfine(none),
               refused: runner.networkRefused(),
               spawned,
             }));
             process.exit(0);`,
          );
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn([process.execPath, "--no-env-file", script], {
            env: {
              PATH: "/usr/bin:/bin",
              HOME: homedir(),
              NIMBUS_SANDBOX_HELPER_PATH: join(root, "no-such-helper"),
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
          const out = JSON.parse(line) as Record<string, unknown>;
          expect(String(out["canConfine"])).toContain("no-such-helper");
          expect(String(out["spawned"])).toContain("refusing to spawn");
          expect(String(out["spawned"])).toContain("no-such-helper");
          expect(out["refused"]).toBe(true);
          expect(out["noNet"]).toBeNull();
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
          const spawned = wrapped(policyOf(["a.example.com"]), box, "process.exit(0);");
          spawned.env["NIMBUS_SANDBOX_HELPER_PATH"] = broken;
          // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
          const proc = Bun.spawn(spawned.argv, {
            env: spawned.env,
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
          expect(report["hosts"]).toBe("127.0.0.1 localhost localhost.\n");
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
          // The same URL from outside the sandbox first. Only that failing is an outage; a host that
          // answers while the sandboxed fetch below fails stays red.
          const hostReached = await fetch(REAL_NETWORK_URL, {
            signal: AbortSignal.timeout(HOST_REACH_TIMEOUT_MS),
          }).then(
            () => true,
            () => false,
          );
          if (!hostReached) {
            console.error(
              `SKIPPED, NOT PROVED: this machine cannot reach ${REAL_NETWORK_URL} even outside the sandbox`,
            );
            return;
          }
          const box = newSandbox(root, "real");
          const { report, ran } = await reportOf(
            wildcardPolicy([]),
            box,
            `report({
               status: await fetch("${REAL_NETWORK_URL}").then((r) => r.status),
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

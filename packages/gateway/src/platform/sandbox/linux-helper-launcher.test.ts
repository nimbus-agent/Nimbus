import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The launcher and forwarder against the REAL binary, inside a real `bwrap` namespace, relaying to a
 * real unix socket. Skipped unless the binary is built and `bwrap` can create a namespace here.
 * CI's helper step sets NIMBUS_REQUIRE_SANDBOX_HELPER, which turns that skip into a failure.
 */
const HELPER = join(import.meta.dir, "../../../src-native/sandbox-helper/nimbus-sandbox-helper");
const BWRAP = "/usr/bin/bwrap";
const ENV = "/usr/bin/env";
const IS_LINUX = process.platform === "linux";
const REQUIRED = process.env["NIMBUS_REQUIRE_SANDBOX_HELPER"] === "1";
/** `bwrap` run by real root keeps every capability, whatever `--cap-add` names. */
const IS_ROOT = process.getuid?.() === 0;

const TEST_TIMEOUT_MS = 60_000;
const SIGCHLD_IGNORED_BIT = 1n << 16n;
const ZERO_CAPS = "0000000000000000";

const LISTEN_443 = "127.0.0.2:443:7";
const RESOLVER_IP = "127.0.0.53";
const KEPT_CAPS = ["CAP_NET_BIND_SERVICE", "CAP_SETPCAP", "CAP_SETFCAP"];

/** A namespace like the wrapper's: new user, net and pid, uid 0, and the three kept capabilities. */
function outerBwrap(
  opts: { extraCaps?: readonly string[]; pidNamespace?: boolean } = {},
): string[] {
  const argv = [BWRAP, "--unshare-user", "--unshare-net", "--uid", "0", "--gid", "0"];
  for (const cap of [...KEPT_CAPS, ...(opts.extraCaps ?? [])]) argv.push("--cap-add", cap);
  argv.push("--ro-bind", "/", "/", "--dev", "/dev");
  // Without a pid namespace the bind of `/` already carries the host's /proc.
  if (opts.pidNamespace !== false) argv.push("--unshare-pid", "--proc", "/proc");
  argv.push("--die-with-parent");
  return argv;
}

function bunProbe(script: string): string[] {
  return [process.execPath, "--no-env-file", "-e", script];
}

function bwrapUsable(): boolean {
  if (!IS_LINUX || !existsSync(BWRAP)) return false;
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const r = spawnSync(BWRAP, [...outerBwrap().slice(1), "/bin/true"], { encoding: "utf8" });
  return r.status === 0;
}

function helperBuilt(): boolean {
  if (!IS_LINUX || !existsSync(HELPER)) return false;
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const r = spawnSync(HELPER, ["--check"], { encoding: "utf8" });
  return r.status === 0 && r.stdout === "OK\n";
}

type Ran = { exitCode: number; stdout: string; stderr: string };

/** Async: the target lives in THIS process, so a synchronous spawn would starve it. */
async function run(argv: readonly string[]): Promise<Ran> {
  // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TEST_TIMEOUT_MS - 5000,
  });
  // Reading stdout to its end is itself a check: anything still holding the pipe hangs here.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

type TargetConn = {
  socket: Socket;
  bytes: Buffer;
  openedAtMs: number;
  endedAtMs: number | null;
};
type TargetEvent = "data" | "end";

/** Stands in for the wrapper: records each unix connection, and answers as a test says to. */
class Target {
  readonly conns: TargetConn[] = [];
  behaviour: (conn: TargetConn, event: TargetEvent) => void = () => undefined;
  private server: Server | null = null;

  listen(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        const conn: TargetConn = {
          socket,
          bytes: Buffer.alloc(0),
          openedAtMs: Date.now(),
          endedAtMs: null,
        };
        this.conns.push(conn);
        socket.on("data", (chunk) => {
          conn.bytes = Buffer.concat([conn.bytes, Buffer.from(chunk)]);
          this.behaviour(conn, "data");
        });
        socket.on("end", () => {
          conn.endedAtMs = Date.now();
          this.behaviour(conn, "end");
        });
        socket.on("error", () => undefined);
      });
      server.once("error", reject);
      server.listen(path, () => resolve());
      this.server = server;
    });
  }

  close(): void {
    for (const conn of this.conns) conn.socket.destroy();
    this.server?.close();
  }
}

/** Answers a complete `D` frame with `reply`, framed the way the wrapper frames one. */
function answerDnsFrame(conn: TargetConn, reply: Buffer): void {
  const { bytes } = conn;
  if (bytes.length < 5) return;
  const length = bytes.readUInt16BE(3);
  if (bytes.length < 5 + length) return;
  const header = Buffer.alloc(2);
  header.writeUInt16BE(reply.length);
  conn.socket.end(Buffer.concat([header, reply]));
}

const CONNECT_AND_HALF_CLOSE = `
const net = require("node:net");
const s = net.connect({ host: "127.0.0.2", port: 443, allowHalfOpen: true });
let got = "";
s.on("data", (d) => { got += d; });
s.on("end", () => { console.log(JSON.stringify({ got })); process.exit(0); });
s.on("connect", () => s.end("hello"));
s.on("error", (e) => { console.log(JSON.stringify({ error: e.code })); process.exit(1); });
`;

/** The forwarder is the probe's only child, since the launcher became the probe at exec. */
const FIND_FORWARDER = `
const fs = require("node:fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusOf = (pid) => { try { return fs.readFileSync("/proc/" + pid + "/status", "utf8"); } catch { return ""; } };
const field = (status, name) => (status.match(new RegExp("^" + name + ":\\\\s*(.+)$", "m")) ?? [])[1];
function children() {
  return fs.readdirSync("/proc").filter((d) => /^\\d+$/.test(d) && field(statusOf(d), "PPid") === String(process.pid));
}
/** Relative to the probe, since a container runtime's own filter is inherited by everything here. */
const filtersAbove = (pid) => Number(field(statusOf(pid), "Seccomp_filters")) - Number(field(statusOf("self"), "Seccomp_filters"));
async function forwarder() {
  let found;
  for (let i = 0; i < 40; i += 1) {
    found = children()[0];
    if (found !== undefined && filtersAbove(found) === 1) return found;
    await sleep(50);
  }
  return found;
}
`;

function exitWith(code: number, payload: string): string {
  return `console.log(JSON.stringify(${payload})); process.exit(${String(code)});`;
}

describe.skipIf(!IS_LINUX || (!helperBuilt() && !REQUIRED))(
  "nimbus-sandbox-helper arguments",
  () => {
    beforeAll(() => {
      expect(helperBuilt()).toBe(true);
    });

    /** Everything here fails in parsing, before any namespace, so it runs with no `bwrap`. */
    function exitOf(args: readonly string[]): number | null {
      // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
      return spawnSync(HELPER, [...args], { encoding: "utf8" }).status;
    }

    const good = ["--socket", "/tmp/s", "--listen", LISTEN_443, "--dns", RESOLVER_IP];

    test("--check prints OK and exits 0", () => {
      // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
      const r = spawnSync(HELPER, ["--check"], { encoding: "utf8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("OK\n");
    });

    test.each<[string, readonly string[]]>([
      ["no arguments", []],
      ["an unknown mode", ["--check-caps"]],
      ["--check with anything after it", ["--check", "x"]],
      ["the old --allow mode", ["--allow", "example.com", "--", "/bin/true"]],
      ["no child argv", good],
      ["an empty child argv", [...good, "--"]],
      ["no --socket", ["--listen", LISTEN_443, "--dns", RESOLVER_IP, "--", "/bin/true"]],
      ["no --listen", ["--socket", "/tmp/s", "--dns", RESOLVER_IP, "--", "/bin/true"]],
      ["no --dns", ["--socket", "/tmp/s", "--listen", LISTEN_443, "--", "/bin/true"]],
      ["a flag with no value", ["--socket"]],
      ["a repeated --socket", ["--socket", "/tmp/t", ...good, "--", "/bin/true"]],
      ["a repeated --dns", ["--dns", RESOLVER_IP, ...good, "--", "/bin/true"]],
      [
        "a socket path too long for sockaddr_un",
        ["--socket", "/".repeat(108), "--listen", LISTEN_443],
      ],
      [
        "an empty socket path",
        ["--socket", "", "--listen", LISTEN_443, "--dns", RESOLVER_IP, "--", "x"],
      ],
      [
        "a --dns that is not IPv4",
        ["--socket", "/tmp/s", "--listen", LISTEN_443, "--dns", "::1", "--", "x"],
      ],
      ["an --alias that is not IPv4", ["--alias", "nope", ...good, "--", "/bin/true"]],
    ])("refuses %s with exit 2", (_name, args) => {
      expect(exitOf(args)).toBe(2);
    });

    test.each<[string]>([
      ["127.0.0.2:0:1"],
      ["127.0.0.2:65536:1"],
      ["127.0.0.2:443:65536"],
      ["127.0.0.2:443:-1"],
      ["127.0.0.2:443:"],
      ["127.0.0.2::1"],
      ["127.0.0.2:44x:1"],
      ["127.0.0.2:443"],
      ["not-an-ip:443:1"],
      ["127.0.0.2:99999999999999999999:1"],
      ["127.0.0.2:443:99999999999999999999"],
    ])("refuses the listen entry %s with exit 2", (entry) => {
      expect(
        exitOf(["--socket", "/tmp/s", "--listen", entry, "--dns", RESOLVER_IP, "--", "/bin/true"]),
      ).toBe(2);
    });

    /**
     * That many arguments are over the default ARG_MAX, a quarter of the stack limit, so a shell
     * raises the limit and `xargs` builds the command line. It reports the helper's own exit code.
     */
    function exitWithListenEntries(count: number): string {
      const script = [
        "ulimit -s 65536 || exit 99",
        `{ yes -- '--listen\n1.1.1.1:1:1' | head -n ${String(count * 2)}; printf -- '--\\n/bin/true\\n'; }` +
          ` | xargs -s 6000000 sh -c '"$0" "$@"; echo "rc=$?"' "$HELPER" --socket /tmp/s --dns ${RESOLVER_IP}`,
      ].join("\n");
      // windows-console-ok: this suite runs only on Linux, where the flag is ignored.
      const r = spawnSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        env: { ...process.env, HELPER },
      });
      return r.stdout.trim();
    }

    test("refuses 65536 listen entries with exit 2, and takes 65535 on to the bind", () => {
      expect(exitWithListenEntries(65536)).toBe("rc=2");
      // 1.1.1.1 is not an address here, so a parse that passed fails at the first bind.
      expect(exitWithListenEntries(65535)).toBe("rc=3");
    });
  },
);

const ready = helperBuilt() && bwrapUsable();

describe.skipIf(!IS_LINUX || (!ready && !REQUIRED))("nimbus-sandbox-helper under bwrap", () => {
  let dir = "";
  let socketPath = "";
  let target: Target;

  beforeAll(() => {
    expect(helperBuilt()).toBe(true);
    expect(bwrapUsable()).toBe(true);
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "nh-"));
    socketPath = join(dir, "s");
    target = new Target();
    await target.listen(socketPath);
  });

  afterEach(() => {
    target.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function helperArgs(
    child: readonly string[],
    listen: readonly string[] = [LISTEN_443],
  ): string[] {
    const args = [HELPER, "--socket", socketPath];
    for (const entry of listen) args.push("--listen", entry);
    args.push("--dns", RESOLVER_IP, "--", ...child);
    return args;
  }

  test(
    "a connection reaches the target with its entry's header, and half-close works both ways",
    async () => {
      target.behaviour = (conn, event) => {
        if (event === "end") conn.socket.end("world");
      };
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(CONNECT_AND_HALF_CLOSE))]);
      expect(r).toEqual({ exitCode: 0, stdout: JSON.stringify({ got: "world" }), stderr: "" });
      expect(target.conns).toHaveLength(1);
      expect([...(target.conns[0]?.bytes ?? [])]).toEqual([
        0x54,
        0x00,
        0x07,
        ...Buffer.from("hello"),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the entry index keeps both of its bytes",
    async () => {
      target.behaviour = (conn, event) => {
        if (event === "end") conn.socket.end("world");
      };
      const r = await run([
        ...outerBwrap(),
        ...helperArgs(bunProbe(CONNECT_AND_HALF_CLOSE), ["127.0.0.2:443:65535"]),
      ]);
      expect(r.exitCode).toBe(0);
      expect([...(target.conns[0]?.bytes.subarray(0, 3) ?? [])]).toEqual([0x54, 0xff, 0xff]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a full-duplex transfer larger than every buffer arrives whole",
    async () => {
      // The target echoes with backpressure, so a relay blocked on one direction deadlocks here.
      let echoing = false;
      target.behaviour = (conn) => {
        if (echoing) return;
        echoing = true;
        const { socket } = conn;
        socket.removeAllListeners("data");
        const rest = conn.bytes.subarray(3);
        if (rest.length > 0) socket.write(rest);
        socket.pipe(socket);
      };
      const script = `
const net = require("node:net");
const size = 8 * 1024 * 1024;
const data = Buffer.alloc(size);
for (let i = 0; i < size; i += 1) data[i] = i % 251;
const s = net.connect({ host: "127.0.0.2", port: 443, allowHalfOpen: true });
let received = 0;
let intact = true;
s.on("data", (d) => {
  for (let i = 0; i < d.length; i += 1) if (d[i] !== (received + i) % 251) intact = false;
  received += d.length;
  if (received === size) { console.log(JSON.stringify({ received, intact })); process.exit(0); }
});
s.on("connect", () => s.write(data));
s.on("close", () => { console.log(JSON.stringify({ received, intact })); process.exit(1); });
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual({ received: 8 * 1024 * 1024, intact: true });
      expect(r.exitCode).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a datagram reaches the target framed, and the reply reaches the sender",
    async () => {
      target.behaviour = (conn) => answerDnsFrame(conn, Buffer.from("reply"));
      const script = `
const dgram = require("node:dgram");
const s = dgram.createSocket("udp4");
s.on("message", (m) => { console.log(JSON.stringify({ got: m.toString() })); process.exit(0); });
s.send(Buffer.from("query"), 53, ${JSON.stringify(RESOLVER_IP)});
setTimeout(() => { console.log(JSON.stringify({ got: null })); process.exit(1); }, 20000);
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      expect(r).toEqual({ exitCode: 0, stdout: JSON.stringify({ got: "reply" }), stderr: "" });
      expect(target.conns).toHaveLength(1);
      expect([...(target.conns[0]?.bytes ?? [])]).toEqual([
        0x44,
        0x00,
        0x00,
        0x00,
        0x05,
        ...Buffer.from("query"),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a datagram over 4096 bytes is dropped, and one of 4096 is relayed",
    async () => {
      target.behaviour = (conn) => answerDnsFrame(conn, Buffer.from("r"));
      const script = `
const dgram = require("node:dgram");
const s = dgram.createSocket("udp4");
s.on("message", () => { console.log(JSON.stringify({ replied: true })); process.exit(0); });
s.send(Buffer.alloc(4097), 53, ${JSON.stringify(RESOLVER_IP)});
s.send(Buffer.alloc(4096), 53, ${JSON.stringify(RESOLVER_IP)});
setTimeout(() => { console.log(JSON.stringify({ replied: false })); process.exit(1); }, 20000);
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      expect(JSON.parse(r.stdout)).toEqual({ replied: true });
      expect(target.conns).toHaveLength(1);
      expect(target.conns[0]?.bytes.length).toBe(5 + 4096);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a datagram's relay gives up 5 seconds after an unanswered query",
    async () => {
      const script = `
const dgram = require("node:dgram");
const s = dgram.createSocket("udp4");
s.send(Buffer.from("query"), 53, ${JSON.stringify(RESOLVER_IP)});
setTimeout(() => process.exit(0), 10000);
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      expect(r.exitCode).toBe(0);
      const conn = target.conns[0];
      expect(conn?.endedAtMs).not.toBeNull();
      const waited = (conn?.endedAtMs ?? 0) - (conn?.openedAtMs ?? 0);
      // Well before the probe's own 10 s exit is what tells this from the namespace dying.
      expect(waited).toBeGreaterThanOrEqual(4500);
      expect(waited).toBeLessThan(9000);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "at 512 relays a connection closes at once and a datagram drops, and both recover",
    async () => {
      target.behaviour = (conn, event) => {
        if (event === "end") conn.socket.end();
        else if (conn.bytes[0] === 0x44) answerDnsFrame(conn, Buffer.from("r"));
        else if (conn.bytes.length === 3) conn.socket.write("k");
      };
      const script = `
const net = require("node:net");
const dgram = require("node:dgram");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const total = 600;
let acked = 0;
let closed = 0;
const socks = [];
for (let i = 0; i < total; i += 1) {
  const s = net.connect({ host: "127.0.0.2", port: 443 });
  let wasAcked = false;
  s.on("data", () => { if (!wasAcked) { wasAcked = true; acked += 1; } });
  s.on("close", () => { if (!wasAcked) closed += 1; });
  s.on("error", () => undefined);
  socks.push(s);
  if (i % 20 === 19) await sleep(1);
}
const settleBy = Date.now() + 45000;
while (acked + closed < total && Date.now() < settleBy) await sleep(50);
const u = dgram.createSocket("udp4");
let replies = 0;
u.on("message", () => { replies += 1; });
u.send(Buffer.from("q"), 53, ${JSON.stringify(RESOLVER_IP)});
await sleep(1000);
const repliesAtCap = replies;
for (const s of socks) s.destroy();
const recoverBy = Date.now() + 8000;
while (replies === 0 && Date.now() < recoverBy) {
  u.send(Buffer.from("q"), 53, ${JSON.stringify(RESOLVER_IP)});
  await sleep(200);
}
console.log(JSON.stringify({ acked, closed, repliesAtCap, recovered: replies > 0 }));
process.exit(0);
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual({
        acked: 512,
        closed: 88,
        repliesAtCap: 0,
        recovered: true,
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the child holds none of the listeners",
    async () => {
      const script = `
const fs = require("node:fs");
const listening = new Set();
for (const [file, state] of [["/proc/net/tcp", "0A"], ["/proc/net/udp", "07"]]) {
  for (const line of fs.readFileSync(file, "utf8").trim().split("\\n").slice(1)) {
    const cols = line.trim().split(/\\s+/);
    if (cols[3] === state) listening.add(cols[9]);
  }
}
const held = [];
for (const fd of fs.readdirSync("/proc/self/fd")) {
  let link = "";
  try { link = fs.readlinkSync("/proc/self/fd/" + fd); } catch { continue; }
  const inode = (link.match(/^socket:\\[(\\d+)\\]$/) ?? [])[1];
  if (inode !== undefined && listening.has(inode)) held.push(fd);
}
console.log(JSON.stringify({ listening: listening.size, held }));
`;
      const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
      // Two listening sockets is the proof the probe looked somewhere the listeners actually are.
      expect(r).toEqual({
        exitCode: 0,
        stdout: JSON.stringify({ listening: 2, held: [] }),
        stderr: "",
      });
    },
    TEST_TIMEOUT_MS,
  );

  describe("SIGCHLD", () => {
    const READ_SIGIGN = ["/bin/grep", "SigIgn", "/proc/self/status"];

    function sigIgn(stdout: string): bigint {
      const hex = stdout.split(/\s+/)[1];
      if (hex === undefined) throw new Error(`no SigIgn in: ${stdout}`);
      return BigInt(`0x${hex}`);
    }

    test(
      "control: env really does hand an ignored SIGCHLD through exec",
      async () => {
        const r = await run([ENV, "--ignore-signal=CHLD", ...READ_SIGIGN]);
        expect(r.exitCode).toBe(0);
        expect(sigIgn(r.stdout) & SIGCHLD_IGNORED_BIT).toBe(SIGCHLD_IGNORED_BIT);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an ignored SIGCHLD the launcher inherited does not reach the child",
      async () => {
        const r = await run([
          ...outerBwrap(),
          ENV,
          "--ignore-signal=CHLD",
          ...helperArgs(READ_SIGIGN),
        ]);
        expect(r.exitCode).toBe(0);
        expect(sigIgn(r.stdout) & SIGCHLD_IGNORED_BIT).toBe(0n);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the child can spawn and wait for a subprocess",
      async () => {
        const script = `
const { spawnSync } = require("node:child_process");
const r = spawnSync("/bin/sh", ["-c", "exit 9"]);
console.log(JSON.stringify({ status: r.status, error: r.error?.code ?? null }));
`;
        const r = await run([
          ...outerBwrap(),
          ENV,
          "--ignore-signal=CHLD",
          ...helperArgs(bunProbe(script)),
        ]);
        expect(r).toEqual({
          exitCode: 0,
          stdout: JSON.stringify({ status: 9, error: null }),
          stderr: "",
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an inherited ignored SIGCHLD does not stop the forwarder counting its relays",
      async () => {
        // With SIGCHLD ignored `wait4` never reports a relay, so the count would stay at the cap.
        target.behaviour = (conn, event) => {
          if (event === "end") conn.socket.end();
          else if (conn.bytes.length === 3) conn.socket.write("k");
        };
        const script = `
const net = require("node:net");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const socks = [];
const attempt = () => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.2", port: 443 });
  socks.push(s);
  s.on("data", () => resolve(true));
  s.on("close", () => resolve(false));
  s.on("error", () => undefined);
});
const held = [];
for (let i = 0; i < 512; i += 1) held.push(attempt());
const served = (await Promise.all(held)).filter(Boolean).length;
const overCap = await attempt();
for (const s of socks) s.destroy();
let recovered = false;
const recoverBy = Date.now() + 8000;
while (!recovered && Date.now() < recoverBy) {
  await sleep(100);
  recovered = await attempt();
}
console.log(JSON.stringify({ served, overCap, recovered }));
process.exit(0);
`;
        const r = await run([
          ...outerBwrap(),
          ENV,
          "--ignore-signal=CHLD",
          ...helperArgs(bunProbe(script)),
        ]);
        expect(JSON.parse(r.stdout)).toEqual({ served: 512, overCap: false, recovered: true });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("shutdown", () => {
    test(
      "the exit code is the child's, and the pipe sees EOF even with a relay still open",
      async () => {
        const script = `
const net = require("node:net");
const s = net.connect({ host: "127.0.0.2", port: 443 });
s.on("connect", () => {
  console.log("up");
  setTimeout(() => process.exit(7), 300);
});
`;
        const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
        expect(r).toEqual({ exitCode: 7, stdout: "up", stderr: "" });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "with no pid namespace to end it, the forwarder still dies with the launcher",
      async () => {
        const script = `${FIND_FORWARDER}
const pid = await forwarder();
console.log(JSON.stringify({ pid }));
process.exit(0);
`;
        const r = await run([
          ...outerBwrap({ pidNamespace: false }),
          ...helperArgs(bunProbe(script)),
        ]);
        expect(r.exitCode).toBe(0);
        const { pid } = JSON.parse(r.stdout) as { pid: string };
        expect(pid).toMatch(/^\d+$/);
        const isGone = (): boolean => {
          try {
            // Nothing need reap it here, so an exited forwarder may stay a zombie.
            return /^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));
          } catch {
            return true;
          }
        };
        const deadline = Date.now() + 5000;
        while (!isGone() && Date.now() < deadline) await Bun.sleep(50);
        expect(isGone()).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a killed forwarder takes the listeners with it, and nothing falls back to a route",
      async () => {
        const script = `${FIND_FORWARDER}
const net = require("node:net");
const pid = await forwarder();
process.kill(Number(pid), "SIGKILL");
await sleep(200);
const outcome = await new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.2", port: 443 });
  s.on("connect", () => resolve("connected"));
  s.on("error", (e) => resolve(e.code));
});
console.log(JSON.stringify({ outcome }));
process.exit(0);
`;
        const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
        expect(r.stdout).toBe(JSON.stringify({ outcome: "ECONNREFUSED" }));
        expect(target.conns).toHaveLength(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a forwarder stopped and continued keeps relaying, since its poll resumes through the filter",
      async () => {
        target.behaviour = (conn, event) => {
          if (event === "end") conn.socket.end("world");
        };
        const script = `${FIND_FORWARDER}
const pid = Number(await forwarder());
await sleep(200);
process.kill(pid, "SIGSTOP");
await sleep(200);
process.kill(pid, "SIGCONT");
await sleep(200);
${CONNECT_AND_HALF_CLOSE}`;
        const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
        expect(r).toEqual({ exitCode: 0, stdout: JSON.stringify({ got: "world" }), stderr: "" });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a socket path that is gone closes the accepted connection",
      async () => {
        const script = `
const net = require("node:net");
const s = net.connect({ host: "127.0.0.2", port: 443 });
let got = "";
s.on("data", (d) => { got += d; });
s.on("error", () => undefined);
s.on("close", () => { console.log(JSON.stringify({ got })); process.exit(0); });
`;
        const r = await run([
          ...outerBwrap(),
          HELPER,
          "--socket",
          join(dir, "missing"),
          "--listen",
          LISTEN_443,
          "--dns",
          RESOLVER_IP,
          "--",
          ...bunProbe(script),
        ]);
        expect(r).toEqual({ exitCode: 0, stdout: JSON.stringify({ got: "" }), stderr: "" });
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("the forwarder's confinement", () => {
    test(
      "no capability in any set, no new privileges, a seccomp filter",
      async () => {
        const script = `${FIND_FORWARDER}
const pid = await forwarder();
const status = statusOf(pid);
console.log(JSON.stringify({
  ...Object.fromEntries(["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb", "NoNewPrivs"].map((n) => [n, field(status, n)])),
  filtersAdded: filtersAbove(pid),
}));
`;
        const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout)).toEqual({
          CapInh: ZERO_CAPS,
          CapPrm: ZERO_CAPS,
          CapEff: ZERO_CAPS,
          CapBnd: ZERO_CAPS,
          CapAmb: ZERO_CAPS,
          NoNewPrivs: "1",
          filtersAdded: 1,
        });
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "control: the launcher's own capabilities reach its exec, since the inner bwrap needs them",
      async () => {
        const script = `${FIND_FORWARDER}
console.log(JSON.stringify({ capEff: field(statusOf("self"), "CapEff") }));
`;
        const r = await run([...outerBwrap(), ...helperArgs(bunProbe(script))]);
        const { capEff } = JSON.parse(r.stdout) as { capEff: string };
        expect(capEff).not.toBe(ZERO_CAPS);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "stdio is /dev/null and an inherited fd 3 is closed, in the forwarder only",
      async () => {
        const script = `${FIND_FORWARDER}
const pid = await forwarder();
const links = {};
for (const fd of ["0", "1", "2", "3"]) {
  try { links[fd] = fs.readlinkSync("/proc/" + pid + "/fd/" + fd); } catch (e) { links[fd] = e.code; }
}
console.log(JSON.stringify({ links, mine: fs.readlinkSync("/proc/self/fd/3") }));
`;
        // `sh` runs inside the namespace, so nothing between it and the launcher can touch fd 3.
        const r = await run([
          ...outerBwrap(),
          "/bin/sh",
          "-c",
          'exec 3</dev/null; exec "$0" "$@"',
          ...helperArgs(bunProbe(script)),
        ]);
        expect(r.stderr).toBe("");
        expect(JSON.parse(r.stdout)).toEqual({
          links: { "0": "/dev/null", "1": "/dev/null", "2": "/dev/null", "3": "ENOENT" },
          mine: "/dev/null",
        });
      },
      TEST_TIMEOUT_MS,
    );
  });

  test.skipIf(IS_ROOT)(
    "the real layout: an inner bwrap starts under the launcher, its child has no capability",
    async () => {
      target.behaviour = (conn, event) => {
        if (event === "end") conn.socket.end("world");
      };
      const uid = String(process.getuid?.() ?? 0);
      const gid = String(process.getgid?.() ?? 0);
      const inner = [
        BWRAP,
        "--unshare-user",
        "--unshare-pid",
        "--uid",
        uid,
        "--gid",
        gid,
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        "--proc",
        "/proc",
        "--die-with-parent",
      ];
      const script = `
const net = require("node:net");
const fs = require("node:fs");
const capEff = fs.readFileSync("/proc/self/status", "utf8").match(/^CapEff:\\s*(\\S+)$/m)[1];
const s = net.connect({ host: "127.0.0.2", port: 443, allowHalfOpen: true });
let got = "";
s.on("data", (d) => { got += d; });
s.on("end", () => { ${exitWith(7, "{ got, capEff, uid: process.getuid() }")} });
s.on("connect", () => s.end("hello"));
s.on("error", (e) => { ${exitWith(1, "{ error: e.code }")} });
`;
      const r = await run([...outerBwrap(), ...helperArgs([...inner, ...bunProbe(script)])]);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual({ got: "world", capEff: ZERO_CAPS, uid: Number(uid) });
      expect(r.exitCode).toBe(7);
    },
    TEST_TIMEOUT_MS,
  );

  describe("an IP literal's address", () => {
    const ALIAS = "10.1.2.3";
    const PROBE_ALIAS = `
const net = require("node:net");
const attempt = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: 8443 });
  const t = setTimeout(() => { s.destroy(); resolve("timeout"); }, 5000);
  s.on("connect", () => { clearTimeout(t); s.destroy(); resolve("connected"); });
  s.on("error", (e) => { clearTimeout(t); resolve(e.code); });
});
const bindable = (host) => new Promise((resolve) => {
  const server = net.createServer();
  server.on("error", (e) => resolve(e.code));
  server.listen(0, host, () => { server.close(); resolve("bound"); });
});
console.log(JSON.stringify({
  alias: await attempt(${JSON.stringify(ALIAS)}),
  neighbour: await attempt("10.1.2.4"),
  neighbourBind: await bindable("10.1.2.4"),
}));
process.exit(0);
`;

    test(
      "--alias makes exactly that address listenable, and its neighbours stay unreachable",
      async () => {
        const r = await run([
          ...outerBwrap({ extraCaps: ["CAP_NET_ADMIN"] }),
          HELPER,
          "--socket",
          socketPath,
          "--alias",
          ALIAS,
          "--listen",
          `${ALIAS}:8443:3`,
          "--dns",
          RESOLVER_IP,
          "--",
          ...bunProbe(PROBE_ALIAS),
        ]);
        expect(r.stderr).toBe("");
        // With the classful /8 the kernel treats the whole of 10.0.0.0/8 as local, so the bind works.
        const outcome = JSON.parse(r.stdout) as {
          alias: string;
          neighbour: string;
          neighbourBind: string;
        };
        expect(outcome.alias).toBe("connected");
        expect(["ECONNREFUSED", "ENETUNREACH"]).toContain(outcome.neighbour);
        expect(outcome.neighbourBind).toBe("EADDRNOTAVAIL");
      },
      TEST_TIMEOUT_MS,
    );

    test.skipIf(IS_ROOT)(
      "an alias that cannot be applied exits 5 and names the address",
      async () => {
        const r = await run([
          ...outerBwrap(),
          HELPER,
          "--socket",
          socketPath,
          "--alias",
          ALIAS,
          "--listen",
          `${ALIAS}:8443:3`,
          "--dns",
          RESOLVER_IP,
          "--",
          "/bin/true",
        ]);
        expect(r.exitCode).toBe(5);
        expect(r.stderr).toContain(ALIAS);
      },
      TEST_TIMEOUT_MS,
    );
  });

  describe("startup failures", () => {
    test(
      "a listener already bound exits 3 and names the address",
      async () => {
        const r = await run([
          ...outerBwrap(),
          ...helperArgs(["/bin/true"], [LISTEN_443, "127.0.0.2:443:8"]),
        ]);
        expect(r.exitCode).toBe(3);
        expect(r.stderr).toContain("127.0.0.2:443");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a --dns address that cannot be bound exits 3 and names it",
      async () => {
        const r = await run([
          ...outerBwrap(),
          HELPER,
          "--socket",
          socketPath,
          "--listen",
          LISTEN_443,
          "--dns",
          "10.9.9.9",
          "--",
          "/bin/true",
        ]);
        expect(r.exitCode).toBe(3);
        expect(r.stderr).toContain("10.9.9.9:53");
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an exec failure exits 127",
      async () => {
        const r = await run([...outerBwrap(), ...helperArgs(["/nonexistent/child"])]);
        expect(r.exitCode).toBe(127);
        expect(r.stderr).toContain("/nonexistent/child");
      },
      TEST_TIMEOUT_MS,
    );
  });
});

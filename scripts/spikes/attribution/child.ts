// Spike 6a child. Runs under the real sandbox (or, with --control, outside it) and opens TCP
// connections to HOST:443, recording each one's local port, so the driver can check what the
// poller saw against the truth. Prints one JSON line: { pid, role, connections: [...] }.
// Modes: (default) the sandboxed child, which also starts a grandchild; --grand; --control.
import { spawn } from "node:child_process";
import { connect } from "node:net";

const HOST = "api.github.com";
const PORT = 443;
const role = process.argv.includes("--grand")
  ? "grandchild"
  : process.argv.includes("--control")
    ? "control"
    : "child";

type Conn = { localPort: number; holdMs: number; kind: string; ok: boolean; error?: string };

function open(holdMs: number, kind: string): Promise<Conn> {
  process.stderr.write(`[${role}] open ${kind}
`);
  return new Promise((resolve) => {
    const s = connect({ host: HOST, port: PORT });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ localPort: 0, holdMs, kind, ok: false, error: "timeout" });
    }, 10_000);
    s.once("connect", () => {
      const localPort = s.localPort ?? 0;
      setTimeout(() => {
        clearTimeout(timer);
        s.destroy();
        resolve({ localPort, holdMs, kind, ok: true });
      }, holdMs);
    });
    s.once("error", (e) => {
      clearTimeout(timer);
      resolve({ localPort: 0, holdMs, kind, ok: false, error: e.message });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The grandchild is the OS's own curl, not bun: inside the Windows AppContainer the child cannot
// start bun.exe again (uv_spawn ENOENT, seen locally 2026-11-03), and a piped bun grandchild hung.
// System32 and /usr/bin are readable inside both sandboxes. Each curl makes one HTTPS request
// (one TCP connection, held for the TLS handshake and the reply); its PID is the truth.
const CURL = process.platform === "win32" ? "C:\\Windows\\System32\\curl.exe" : "/usr/bin/curl";
const DEVNULL = process.platform === "win32" ? "NUL" : "/dev/null";

function runCurl(): Promise<{ pid?: number; exit?: number | null; error?: string }> {
  return new Promise((resolve) => {
    const p = spawn(CURL, ["-s", "-o", DEVNULL, "--max-time", "10", `https://${HOST}/`], {
      stdio: "ignore",
      env: process.env,
    });
    const timer = setTimeout(() => {
      p.kill();
      resolve({ pid: p.pid, error: "curl did not finish within 15 s" });
    }, 15_000);
    p.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ pid: p.pid, exit: code });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ pid: p.pid, error: `curl spawn failed: ${e.message}` });
    });
  });
}

async function runGrandchildren(): Promise<unknown[]> {
  process.stderr.write(`[${role}] spawning curl grandchildren\n`);
  const out: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    out.push(await runCurl());
    await sleep(200);
  }
  return out;
}

async function main(): Promise<void> {
  const connections: Conn[] = [];
  let grandchild: unknown;
  // Give the poller time to start and to see the process tree before the first connection.
  await sleep(role === "grandchild" ? 200 : 1500);
  if (role === "grandchild") {
    for (let i = 0; i < 5; i++) {
      connections.push(await open(50, "grand-50ms"));
      await sleep(100);
    }
  } else {
    // Short: closed the moment it connects. Medium: held 50 ms. Long: held 2 s.
    for (let i = 0; i < 20; i++) {
      connections.push(await open(0, "short"));
      await sleep(150);
    }
    for (let i = 0; i < 5; i++) {
      connections.push(await open(50, "medium-50ms"));
      await sleep(150);
    }
    connections.push(await open(2000, "long-2s"));
    if (role === "child") grandchild = await runGrandchildren();
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, role, connections, grandchild })}\n`);
}

await main();

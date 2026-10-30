// THROWAWAY. The published package, the real sandbox role, a real bundled connector, a real request.
// The token is a made-up string, so GitHub can only answer that it is bad, and that answer is the proof.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const GW = "/usr/lib/nimbus/bin/nimbus-gateway";

function mcp(
  connector: string,
  network: string[],
  env: Record<string, string>,
  call?: { name: string; args: Record<string, unknown> },
): Promise<void> {
  const cwd = join(mkdtempSync("/tmp/rp-"), "cwd");
  const child = spawn(GW, ["__nimbus-sandbox", GW, "__nimbus-connector", connector], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: process.env["HOME"] ?? "/tmp",
      NIMBUS_SANDBOX_POLICY_JSON: JSON.stringify({
        id: `com.nimbus.${connector}`,
        permissions: { network, filesystem: { read: [], write: [] } },
      }),
      NIMBUS_SANDBOX_CWD: cwd,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (m: unknown): void => {
    child.stdin.write(`${JSON.stringify(m)}\n`);
  };
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    let buf = "";
    const done = (msg: string): void => {
      console.log(`${connector}: ${msg}`);
      child.kill();
      resolve();
    };
    const timer = setTimeout(() => done(`TIMEOUT stderr=[${stderr.slice(-300)}]`), 40000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(`EXITED ${String(code)} stderr=[${stderr.slice(-300)}]`);
    });
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        let m: { id?: number; result?: { tools?: unknown[]; content?: { text?: string }[]; isError?: boolean } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
        } else if (m.id === 2) {
          console.log(`${connector}: tools/list returned ${m.result?.tools?.length ?? 0} tools`);
          if (call === undefined) {
            clearTimeout(timer);
            child.removeAllListeners("exit");
            done("handshake ok, no network call asked for");
            return;
          }
          send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: call.name, arguments: call.args } });
        } else if (m.id === 3) {
          clearTimeout(timer);
          child.removeAllListeners("exit");
          const text = m.result?.content?.[0]?.text ?? JSON.stringify(m);
          done(`${call?.name} isError=${String(m.result?.isError)} -> ${text.slice(0, 200)}`);
          return;
        }
      }
    });
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "release-proof", version: "1" } },
    });
  });
}

await mcp("github", ["api.github.com", "uploads.github.com", "raw.githubusercontent.com"], { GITHUB_PAT: "not-a-real-token" }, {
  name: "github_repo_list",
  args: {},
});
await mcp("filesystem", [], {});
process.exit(0);

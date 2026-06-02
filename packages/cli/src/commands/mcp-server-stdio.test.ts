import { describe, expect, it } from "bun:test";
import { join } from "node:path";

// packages/cli/src/index.ts — the real CLI entrypoint, so this exercises banner/logger paths.
const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");
// In the SDK 1.29.0 SUPPORTED_PROTOCOL_VERSIONS list; pin a stable one to avoid handshake drift.
const MCP_PROTOCOL_VERSION = "2024-11-05";

function rpcLine(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !pred()) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("mcp-server --stdio stdout hygiene", () => {
  it("emits nothing on startup, then only valid JSON-RPC lines (no banner/log pollution)", async () => {
    const proc = Bun.spawn(["bun", CLI_ENTRY, "mcp-server", "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NIMBUS_QUIET: "1" },
    });

    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    // Single background pump — never call reader.read() concurrently.
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          if (value !== undefined) {
            buf += decoder.decode(value, { stream: true });
          }
        }
      } catch {
        /* reader canceled on teardown */
      }
    })();

    try {
      // 1) Nothing on stdout before any input: no intro banner, no logger output.
      await new Promise((r) => setTimeout(r, 700));
      expect(buf).toBe("");

      // 2) Minimal MCP handshake, then list tools.
      proc.stdin.write(
        rpcLine({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "hygiene-test", version: "0" },
          },
        }),
      );
      proc.stdin.write(rpcLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
      proc.stdin.write(rpcLine({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      await proc.stdin.flush();

      await waitUntil(() => buf.includes("searchIndex"), 5000);

      // 3) Every non-empty stdout line must parse as JSON — no interleaved banner/log text.
      const lines = buf.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }

      // 4) The tools/list response is present and includes our tools.
      expect(buf).toContain("searchIndex");
      expect(buf).toContain("getRecentPullRequests");
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      proc.kill();
      await proc.exited;
      await pump;
    }
  }, 20_000);
});

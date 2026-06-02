import { afterAll, describe, expect, it } from "bun:test";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import type { AdapterDeps } from "../mcp/adapter.ts";
import {
  formatConfigBlock,
  type MCP_SERVER_CONFIG,
  parseMcpServerArgs,
  type RunMcpServerDeps,
  runMcpServer,
} from "./mcp-server.ts";

const out = captureOutput();
afterAll(() => {
  out.restore();
});

describe("parseMcpServerArgs", () => {
  it("returns help on help flags", () => {
    expect(parseMcpServerArgs(["help"])).toEqual({ kind: "help" });
    expect(parseMcpServerArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseMcpServerArgs(["-h"])).toEqual({ kind: "help" });
  });
  it("returns stdio when --stdio present", () => {
    expect(parseMcpServerArgs(["--stdio"])).toEqual({ kind: "stdio" });
  });
  it("defaults to config", () => {
    expect(parseMcpServerArgs([])).toEqual({ kind: "config" });
  });
});

describe("formatConfigBlock / MCP_SERVER_CONFIG", () => {
  it("embeds a valid JSON block pointing at `mcp-server --stdio`", () => {
    const block = formatConfigBlock();
    const jsonStart = block.indexOf("{");
    const parsed = JSON.parse(block.slice(jsonStart)) as typeof MCP_SERVER_CONFIG;
    expect(parsed.mcpServers.nimbus.command).toBe("nimbus");
    expect(parsed.mcpServers.nimbus.args).toEqual(["mcp-server", "--stdio"]);
  });
});

function fakeRunDeps(): { deps: RunMcpServerDeps; ran: { count: number } } {
  const ran = { count: 0 };
  const adapterDeps: AdapterDeps = {
    getClient: async () => ({ call: async () => null, disconnect: async () => {} }),
  };
  return {
    ran,
    deps: {
      makeDeps: () => adapterDeps,
      runStdio: async (d) => {
        expect(d).toBe(adapterDeps);
        ran.count += 1;
      },
    },
  };
}

describe("runMcpServer", () => {
  it("prints the config block by default and does not run the server", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer([], deps);
    expect(out.stdout).toContain('"mcp-server"');
    expect(ran.count).toBe(0);
  });

  it("prints help on --help", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer(["--help"], deps);
    expect(out.stdout).toContain("nimbus mcp-server");
    expect(ran.count).toBe(0);
  });

  it("runs the stdio server on --stdio using injected deps", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer(["--stdio"], deps);
    expect(ran.count).toBe(1);
  });
});

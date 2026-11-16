// The production wiring of `nimbus agent`. It runs against a scratch data directory and injected
// streams: never the real gateway, the real terminal, or the real home directory's agent files.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliExit } from "../lib/cli-exit.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { AGENT_USAGE } from "./agent.ts";
import { type AgentIo, productionAgentDeps, REAL_AGENT_IO, runAgentCmd } from "./agent-cmd.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function io(stdin = ""): { over: Partial<AgentIo>; out: string[]; err: string[] } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-agent-cmd-"));
  temps.push(root);
  const paths: CliPlatformPaths = {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
  };
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    over: {
      paths: () => paths,
      readStdin: () => Promise.resolve(stdin),
      stdout: (s) => {
        out.push(s);
      },
      stderr: (s) => {
        err.push(s);
      },
      which: () => null,
    },
  };
}

describe("nimbus agent (production wiring)", () => {
  test("a usage error is printed on stderr and ends the command with exit code 2", async () => {
    const h = io();
    const e = await runAgentCmd(["frobnicate"], h.over).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CliExit);
    expect((e as CliExit).code).toBe(2);
    expect(h.err.join("")).toBe(`${AGENT_USAGE}\n`);
  });

  test("the hook reads stdin, answers on stdout and returns normally", async () => {
    const h = io(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "nimbus approvals" } }),
    );
    await runAgentCmd(["hook", "claude-code"], h.over);
    expect(JSON.parse(h.out.join(""))).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const quiet = io(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }));
    await runAgentCmd(["hook", "claude-code"], quiet.over);
    expect(quiet.out.join("")).toBe("");
  });

  test("run from a source tree, install is refused before anything is planned (this test runs under bun)", async () => {
    const h = io();
    const e = await runAgentCmd(["install", "codex", "--dry-run"], h.over).catch((x: unknown) => x);
    expect((e as CliExit).code).toBe(1);
    expect(h.err.join("")).toContain("needs an installed nimbus");
    expect(h.out).toEqual([]);
  });

  test("with no gateway state in the data directory the gateway is reported as not answering", async () => {
    const deps = productionAgentDeps(io().over);
    expect(await deps.gatewayAnswers()).toBe(false);
  });

  test("an agent program that is not on PATH has no version, and nothing is started", async () => {
    const deps = productionAgentDeps(io().over);
    expect(await deps.versionOf("claude")).toBe("not found");
  });

  test("an agent program on PATH is started with --version, directly and with a time limit", async () => {
    const calls: Array<
      [string, string[], { timeout: number; windowsHide: boolean; shell: false }]
    > = [];
    const deps = productionAgentDeps({
      ...io().over,
      which: (name) => `/bin/${name}`,
      exec: (file, args, options, cb) => {
        calls.push([file, args, options]);
        cb(null, "9.9.9\n");
      },
    });
    expect(await deps.versionOf("codex")).toBe("9.9.9");
    expect(calls).toEqual([
      ["/bin/codex", ["--version"], { timeout: 3_000, windowsHide: true, shell: false }],
    ]);
  });

  test("the real streams and PATH lookup are wired: an empty write and an unknown program are harmless", () => {
    REAL_AGENT_IO.stdout("");
    REAL_AGENT_IO.stderr("");
    expect(REAL_AGENT_IO.which("nimbus-no-such-program-anywhere")).toBeNull();
    expect(typeof REAL_AGENT_IO.exec).toBe("function");
    expect(REAL_AGENT_IO.paths().dataDir.length).toBeGreaterThan(0);
    expect(typeof REAL_AGENT_IO.readStdin).toBe("function");
    // With nothing replaced the real inputs are used; building the wiring touches none of them.
    expect(typeof productionAgentDeps().gatewayAnswers).toBe("function");
  });

  test("applying a plan with nothing to change writes nothing", async () => {
    const deps = productionAgentDeps(io().over);
    expect(
      await deps.apply({
        kit: "codex",
        scope: "user",
        files: [],
        manual: [],
        enforcement: "rules",
        notes: [],
      }),
    ).toEqual({ written: [], failure: undefined });
  });
});

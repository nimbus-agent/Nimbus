#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { childExitCode } from "./exit-status.ts";
import { explain, type Platform, resolveNimbusBinary } from "./resolve-binary.ts";

const resolution = resolveNimbusBinary({
  env: process.env,
  platform: process.platform as Platform,
  home: homedir(),
  exists: existsSync,
});

if (resolution.kind !== "found") {
  process.stderr.write(`${explain(resolution)}\n`);
  process.exit(1);
}

const child = spawn(resolution.path, ["mcp-server", "--stdio"], { stdio: "inherit" });
child.on("exit", (code, signal) => {
  process.exit(childExitCode(code, signal));
});
child.on("error", (err) => {
  process.stderr.write(`Failed to start the Nimbus MCP server: ${err.message}\n`);
  process.exit(1);
});

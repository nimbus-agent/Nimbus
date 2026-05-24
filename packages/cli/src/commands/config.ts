import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  getTomlValueFromFile,
  listTomlKeysWithEnv,
  setTomlValueInFile,
} from "../lib/nimbus-toml-config.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

function printConfigHelp(): void {
  console.log(`nimbus config — local TOML + Gateway validation

Usage:
  nimbus config validate   (requires Gateway — checks nimbus.toml in config dir)
  nimbus config list       Print known keys with file vs env source + full file body
  nimbus config get <section.key>   (e.g. telemetry.enabled) — env overrides file
  nimbus config set <section.key> <value>
  nimbus config edit       Open nimbus.toml in $EDITOR (default: notepad on Windows, vi elsewhere)
`);
}

/**
 * Test entry point — invoked by the dispatcher `runConfig(args)` and the
 * colocated `config.test.ts`. Do not call from other command files.
 */
export async function runConfigValidate(client: IPCClient): Promise<void> {
  const r = await client.call<{ ok: boolean; errors: string[]; warnings: string[] }>(
    "config.validate",
    {},
  );
  if (r.warnings.length > 0) {
    for (const w of r.warnings) {
      console.log(`warning: ${w}`);
    }
  }
  if (r.errors.length > 0) {
    for (const e of r.errors) {
      console.log(`error: ${e}`);
    }
  }
  process.exitCode = r.ok ? 0 : 1;
}

function printAdditionalEnvOverrideLegend(): void {
  console.log("");
  console.log(
    "Other NIMBUS_* overrides read by the Gateway (not shown as TOML rows unless also listed above):",
  );
  console.log(
    "  NIMBUS_PROFILE, NIMBUS_HTTP_PORT, NIMBUS_METRICS_PORT, NIMBUS_LOG_LEVEL, NIMBUS_EMBEDDINGS,",
  );
  console.log(
    "  NIMBUS_EMBEDDING_MODEL_DIR, NIMBUS_AGENT_MODEL, NIMBUS_CLASSIFIER_MODEL, NIMBUS_ASK_MAX_STEPS, …",
  );
  console.log(
    "  (see packages/gateway/src/config.ts and packages/gateway/src/platform/assemble.ts)",
  );
}

/**
 * Test entry point — invoked by the dispatcher `runConfig(args)` and the
 * colocated `config.test.ts`. Do not call from other command files.
 */
export function runConfigList(tomlPath: string): void {
  console.log(tomlPath);
  const rows = listTomlKeysWithEnv(tomlPath);
  if (rows.length > 0) {
    console.log("");
    console.log("Key\tSource\tValue");
    for (const r of rows) {
      const src = r.source === "env" ? `env (${r.envVar ?? ""})` : "file";
      console.log(`${r.key}\t${src}\t${r.value}`);
    }
  }
  printAdditionalEnvOverrideLegend();
  if (!existsSync(tomlPath)) {
    console.log("");
    console.log("(file missing)");
    return;
  }
  console.log("");
  console.log(readFileSync(tomlPath, "utf8"));
}

/**
 * Test entry point — invoked by the dispatcher `runConfig(args)` and the
 * colocated `config.test.ts`. Do not call from other command files.
 */
export function runConfigGet(tomlPath: string, key: string): void {
  if (key === "" || !key.includes(".")) {
    throw new Error("Usage: nimbus config get <section.key>  (e.g. telemetry.enabled)");
  }
  const fromEnv = listTomlKeysWithEnv(tomlPath).find((e) => e.key === key && e.source === "env");
  const fromFile = getTomlValueFromFile(tomlPath, key);
  if (fromEnv !== undefined) {
    console.log(fromEnv.value);
    console.log(`(from env ${fromEnv.envVar ?? ""})`);
    return;
  }
  if (fromFile !== undefined) {
    console.log(fromFile);
    return;
  }
  console.log("(not set)");
}

/**
 * Test entry point — invoked by the dispatcher `runConfig(args)` and the
 * colocated `config.test.ts`. Do not call from other command files.
 */
export function runConfigSet(tomlPath: string, key: string, val: string): void {
  if (key === "" || !key.includes(".") || val === "") {
    throw new Error("Usage: nimbus config set <section.key> <value>");
  }
  setTomlValueInFile(tomlPath, key, val);
  console.log(`Updated ${key} in ${tomlPath}`);
  console.log("Restart the Gateway to apply. Env vars still override file values when set.");
}

/**
 * Test entry point — invoked by the dispatcher `runConfig(args)` and the
 * colocated `config.test.ts`. Do not call from other command files.
 *
 * `spawnFn` is a seam for tests so the dispatcher can pass `node:child_process`
 * `spawn` in production and a recorder stub in tests. Returns the editor exit
 * code via the same EventEmitter contract.
 */
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { stdio: "inherit"; shell: boolean },
) => EventEmitter;

export async function runConfigEdit(tomlPath: string, spawnFn?: SpawnFn): Promise<void> {
  const editor = process.env["EDITOR"]?.trim() || (process.platform === "win32" ? "notepad" : "vi");
  const factory: SpawnFn =
    spawnFn ?? ((cmd, a, opts): EventEmitter => spawn(cmd, a, opts) as unknown as EventEmitter);
  await new Promise<void>((resolve, reject) => {
    const child = factory(editor, [tomlPath], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", (err: Error) => {
      reject(err);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${editor} exited with code ${String(code)}`));
      }
    });
  });
}

export async function runConfig(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printConfigHelp();
    return;
  }

  const paths = getCliPlatformPaths();
  const tomlPath = join(paths.configDir, "nimbus.toml");

  if (sub === "validate") {
    await withGatewayIpc((c) => runConfigValidate(c));
    return;
  }

  if (sub === "list") {
    runConfigList(tomlPath);
    return;
  }

  if (sub === "edit") {
    await runConfigEdit(tomlPath);
    return;
  }

  if (sub === "get") {
    const key = args[1]?.trim() ?? "";
    runConfigGet(tomlPath, key);
    return;
  }

  if (sub === "set") {
    const key = args[1]?.trim() ?? "";
    const val = args[2]?.trim() ?? "";
    runConfigSet(tomlPath, key, val);
    return;
  }

  throw new Error(`Unknown config subcommand: ${sub}`);
}

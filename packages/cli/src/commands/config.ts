import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { IPCClient } from "../ipc-client/index.ts";
import type { TomlKeySource } from "../lib/nimbus-toml-config.ts";
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
  nimbus config list [--json]   Print known keys with file vs env source + full file body
  nimbus config get <section.key>   (e.g. telemetry.enabled) — env overrides file
  nimbus config set <section.key> <value>
  nimbus config edit       Open nimbus.toml in $EDITOR (default: notepad on Windows, vi elsewhere)
`);
}

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
  console.log("  NIMBUS_EMBEDDING_MODEL_DIR, NIMBUS_ASK_MAX_STEPS, …");
  console.log(
    "  (see packages/gateway/src/config.ts and packages/gateway/src/platform/assemble.ts)",
  );
}

/**
 * The `nimbus config list --json` document: the resolved config path, whether the file exists, the
 * known keys with their winning source, and the raw file body (`null` when the file is missing).
 * The prose env-override legend the human view prints is static documentation, not data, so it has
 * no JSON counterpart.
 */
export type ConfigListJson = {
  path: string;
  exists: boolean;
  keys: Array<{ key: string; value: string; source: TomlKeySource; envVar: string | null }>;
  raw: string | null;
};

export function runConfigList(tomlPath: string, opts: { json?: boolean } = {}): void {
  const exists = existsSync(tomlPath);
  if (opts.json === true) {
    const payload: ConfigListJson = {
      path: tomlPath,
      exists,
      keys: listTomlKeysWithEnv(tomlPath).map((r) => ({
        key: r.key,
        value: r.value,
        source: r.source,
        envVar: r.envVar ?? null,
      })),
      raw: exists ? readFileSync(tomlPath, "utf8") : null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
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
  if (!exists) {
    console.log("");
    console.log("(file missing)");
    return;
  }
  console.log("");
  console.log(readFileSync(tomlPath, "utf8"));
}

/**
 * Refuse a dotted key that names a NESTED table, naming the command that does work.
 *
 * `nimbus config` addresses a flat `section.key`; a two-dot key used to be split on the first dot
 * and written under the wrong table, where the parser never read it — succeeding loudly and doing
 * nothing (#1382). The lib-level guard in `splitFlatDottedKey` is what makes that fail-closed; this
 * adds the part a user needs, which is where to go instead.
 *
 * `llm.tasks.<task>` gets the specific answer because it is the shape that made the bug reachable
 * and it HAS a dedicated command. Anything else gets the generic answer — inventing a command for
 * a key that has none would trade a silent no-op for a confident wrong instruction.
 */
function refuseNestedKey(dotted: string, value?: string): never {
  const segments = dotted.split(".");
  const base =
    `\`${dotted}\` addresses a nested table, which \`nimbus config\` cannot express — ` +
    "it handles a flat `section.key` only.";
  if (segments.length === 3 && segments[0] === "llm" && segments[1] === "tasks") {
    throw new Error(
      `${base}\nUse: nimbus llm use ${segments[2]} ${value ?? "<routeId>"}` +
        "\nOr edit the [llm.tasks] table in nimbus.toml directly.",
    );
  }
  throw new Error(`${base}\nEdit the table in nimbus.toml directly.`);
}

/** True when the key names a nested table (two or more dots), e.g. `llm.tasks.classification`. */
function isNestedTableKey(key: string): boolean {
  return key.split(".").length > 2;
}

export function runConfigGet(tomlPath: string, key: string): void {
  if (key === "" || !key.includes(".")) {
    throw new Error("Usage: nimbus config get <section.key>  (e.g. telemetry.enabled)");
  }
  if (isNestedTableKey(key)) refuseNestedKey(key);
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

export function runConfigSet(tomlPath: string, key: string, val: string): void {
  if (key === "" || !key.includes(".") || val === "") {
    throw new Error("Usage: nimbus config set <section.key> <value>");
  }
  if (isNestedTableKey(key)) refuseNestedKey(key, val);
  setTomlValueInFile(tomlPath, key, val);
  console.log(`Updated ${key} in ${tomlPath}`);
  console.log("Restart the Gateway to apply. Env vars still override file values when set.");
}

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
    runConfigList(tomlPath, { json: args.includes("--json") });
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

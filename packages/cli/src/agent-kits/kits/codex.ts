/**
 * The Codex CLI kit (Phase 28 AD7b).
 *
 * Read from learn.chatgpt.com/docs on 2026-11-15:
 *  - rules (verbatim): `~/.codex/rules/*.rules`, Starlark
 *    `prefix_rule(pattern=[...], decision="forbidden"|"prompt"|"allow", justification=..., match=[...])`,
 *    the most restrictive match wins, "experimental and may change";
 *  - MCP (from a page SUMMARY, not verbatim): `[mcp_servers.<name>]` with `command` and `args` in
 *    `~/.codex/config.toml`. The kit says so at install and in status until a real run confirms it.
 *
 * User scope only: a project `.codex/` applies only after Codex trusts the project, which Nimbus
 * cannot see, so a project install could silently do nothing.
 */
import { dirname, join } from "node:path";

import {
  fileEdit,
  type KitEnv,
  type KitPlan,
  type KitScope,
  overrideDir,
  serverArgs,
} from "../kit-types.ts";
import { hasBlock, KitRefusal, upsertBlock, withoutBlock } from "../plan-files.ts";
import {
  OWNER_COMMAND_REASON,
  OWNER_COMMANDS,
  renderInstructions,
  STEER_ROWS,
  STEER_TABLE_VERSION,
  steerReason,
} from "../steer-table.ts";

const KIT = "codex";

export const CODEX_MCP_UNVERIFIED =
  "MCP entry format not yet verified against a real Codex (read from a documentation summary)";

/** A TOML basic string and a Starlark string literal share JSON's escapes for these values. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

function list(words: readonly string[]): string {
  return `[${words.map(quoted).join(", ")}]`;
}

function tomlBody(nimbus: string): string {
  return [
    "[mcp_servers.nimbus]",
    `command = ${quoted(nimbus)}`,
    `args = ${list(serverArgs(KIT))}`,
  ].join("\n");
}

function rule(
  argv: readonly string[],
  justification: string,
  resources?: readonly string[],
): string {
  // With resource kinds the pattern's last element is a list of alternatives (the kind as its own
  // word). `deployment/web` in one word is not matched by a prefix rule; the instructions cover it.
  const kinds = resources === undefined ? [] : [list(resources)];
  const pattern = `[${[...argv.map(quoted), ...kinds].join(", ")}]`;
  const words = resources === undefined ? argv : [...argv, resources[0] ?? ""];
  const line = words.join(" ");
  const longer = `${line} ${resources === undefined ? "--help" : "web"}`;
  return [
    "prefix_rule(",
    `    pattern = ${pattern},`,
    `    decision = "forbidden",`,
    `    justification = ${quoted(justification)},`,
    `    match = ${list([line, longer])},`,
    ")",
  ].join("\n");
}

export function codexRulesBody(): string {
  return [
    ...STEER_ROWS.map((r) => rule(r.argv, steerReason(r.actionType), r.resources)),
    ...OWNER_COMMANDS.map((c) => rule(c, OWNER_COMMAND_REASON)),
  ].join("\n\n");
}

/** A TOML key or table name with quotes and the spaces around its dots removed. */
function tomlName(raw: string): string {
  return raw
    .replaceAll('"', "")
    .replaceAll("'", "")
    .split(".")
    .map((part) => part.trim())
    .join(".");
}

const NIMBUS_SERVER = "mcp_servers.nimbus";

function isNimbusServer(name: string): boolean {
  return name === NIMBUS_SERVER || name.startsWith(`${NIMBUS_SERVER}.`);
}

/** The name in a `[table]` or `[[table]]` header line, or undefined when the line is not one. */
function tableHeader(line: string): string | undefined {
  if (!line.startsWith("[")) return undefined;
  const inner = line.startsWith("[[") ? line.slice(2) : line.slice(1);
  const close = inner.indexOf("]");
  return close === -1 ? undefined : tomlName(inner.slice(0, close));
}

/** Why a `key = value` line under `table` collides with the Nimbus table, or undefined. */
function keyConflict(table: string, line: string): string | undefined {
  const equals = line.indexOf("=");
  if (equals <= 0) return undefined;
  const name = tomlName(line.slice(0, equals));
  const full = table === "" ? name : `${table}.${name}`;
  if (full === "mcp_servers") {
    return "defines mcp_servers as an inline table, which cannot be added to";
  }
  return isNimbusServer(full)
    ? "already defines mcp_servers.nimbus, which Nimbus did not write"
    : undefined;
}

/**
 * Why Nimbus's `[mcp_servers.nimbus]` table cannot be appended to this file, or undefined when it
 * can. TOML defines a table once, and an inline table cannot be extended, so each of these would
 * turn a valid file into an invalid one: an `[mcp_servers.nimbus]` table, a `mcp_servers = {...}`
 * inline table, and a `mcp_servers.nimbus...` or (inside `[mcp_servers]`) `nimbus...` key.
 * A line scan, not a parser: it can refuse a file that would have been fine, never accept one
 * that is not.
 */
export function codexServerConflict(text: string): string | undefined {
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = tableHeader(line);
    if (header === undefined) {
      const conflict = keyConflict(table, line);
      if (conflict !== undefined) return conflict;
      continue;
    }
    if (isNimbusServer(header)) {
      return "already has an [mcp_servers.nimbus] table Nimbus did not write";
    }
    table = header;
  }
  return undefined;
}

function editConfig(before: string | null, path: string, nimbus: string): string {
  const conflict =
    before === null ? undefined : codexServerConflict(withoutBlock(before, KIT, "hash"));
  if (conflict !== undefined) {
    throw new KitRefusal(`${path} ${conflict}; remove it or edit the file by hand`);
  }
  return upsertBlock(before, KIT, STEER_TABLE_VERSION, tomlBody(nimbus), "hash");
}

export function planCodex(env: KitEnv, scope: KitScope): KitPlan {
  if (scope === "project") {
    throw new KitRefusal(
      "the Codex kit installs at user scope only: a project .codex/ applies only after Codex trusts the project, which Nimbus cannot see",
    );
  }
  const override = overrideDir(env, "CODEX_HOME");
  const dir = override ?? join(env.home, ".codex");
  const root = override === undefined ? env.home : dirname(override);
  const config = join(dir, "config.toml");
  const rules = join(dir, "rules", "nimbus.rules");
  const agents = join(dir, "AGENTS.md");
  return {
    kit: KIT,
    scope,
    files: [
      fileEdit(
        env,
        root,
        config,
        "mcp",
        (b) => editConfig(b, config, env.nimbus),
        (b) => hasBlock(b, KIT, "hash"),
      ),
      fileEdit(
        env,
        root,
        rules,
        "steer",
        (b) => upsertBlock(b, KIT, STEER_TABLE_VERSION, codexRulesBody(), "hash"),
        (b) => hasBlock(b, KIT, "hash"),
      ),
      fileEdit(
        env,
        root,
        agents,
        "instructions",
        (b) => upsertBlock(b, KIT, STEER_TABLE_VERSION, renderInstructions(), "html"),
        (b) => hasBlock(b, KIT, "html"),
      ),
    ],
    manual: [],
    enforcement: "rules",
    notes: [CODEX_MCP_UNVERIFIED],
  };
}

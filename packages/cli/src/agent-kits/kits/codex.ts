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
import { join } from "node:path";

import { fileEdit, type KitEnv, type KitPlan, type KitScope, serverArgs } from "../kit-types.ts";
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

function rule(argv: readonly string[], justification: string): string {
  const line = argv.join(" ");
  return [
    "prefix_rule(",
    `    pattern = ${list(argv)},`,
    `    decision = "forbidden",`,
    `    justification = ${quoted(justification)},`,
    `    match = ${list([line, `${line} --help`])},`,
    ")",
  ].join("\n");
}

export function codexRulesBody(): string {
  return [
    ...STEER_ROWS.map((r) => rule(r.argv, steerReason(r.actionType))),
    ...OWNER_COMMANDS.map((c) => rule(c, OWNER_COMMAND_REASON)),
  ].join("\n\n");
}

const NIMBUS_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*(?:nimbus|"nimbus"|'nimbus')\s*(?:\]|\.)/m;

function editConfig(before: string | null, path: string, nimbus: string): string {
  // A `[mcp_servers.nimbus]` table the owner wrote would collide with ours (TOML allows a table
  // once): never edit theirs, and never add a second.
  if (before !== null && NIMBUS_TABLE.test(withoutBlock(before, KIT, "hash"))) {
    throw new KitRefusal(
      `${path} already has an [mcp_servers.nimbus] table Nimbus did not write; remove it or edit it by hand`,
    );
  }
  return upsertBlock(before, KIT, STEER_TABLE_VERSION, tomlBody(nimbus), "hash");
}

export function planCodex(env: KitEnv, scope: KitScope): KitPlan {
  if (scope === "project") {
    throw new KitRefusal(
      "the Codex kit installs at user scope only: a project .codex/ applies only after Codex trusts the project, which Nimbus cannot see",
    );
  }
  const dir = env.envVar("CODEX_HOME") ?? join(env.home, ".codex");
  const config = join(dir, "config.toml");
  const rules = join(dir, "rules", "nimbus.rules");
  const agents = join(dir, "AGENTS.md");
  return {
    kit: KIT,
    scope,
    files: [
      fileEdit(
        env,
        config,
        "mcp",
        (b) => editConfig(b, config, env.nimbus),
        (b) => hasBlock(b, KIT, "hash"),
      ),
      fileEdit(
        env,
        rules,
        "steer",
        (b) => upsertBlock(b, KIT, STEER_TABLE_VERSION, codexRulesBody(), "hash"),
        (b) => hasBlock(b, KIT, "hash"),
      ),
      fileEdit(
        env,
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

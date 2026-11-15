/**
 * The Claude Code kit (Phase 28 AD7b).
 *
 * Formats read from code.claude.com/docs on 2026-11-15:
 *  - project MCP: `.mcp.json`, top-level `mcpServers`, an entry with no `type` is stdio;
 *  - settings: `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) and
 *    `.claude/settings.json`, strict JSON;
 *  - a `PreToolUse` hook with `args` is spawned directly, with no shell;
 *  - `permissions.deny` rules: `Bash(<prefix> *)`, deny wins over ask and allow.
 *
 * User-scope MCP servers live in `~/.claude.json`, a file Claude Code writes for itself and whose
 * shape for that scope is not documented. Nimbus does not edit it and does not run `claude`: the
 * entry is ONE command the owner runs.
 */
import { dirname, join } from "node:path";

import {
  assertProject,
  fileEdit,
  type KitEnv,
  type KitPlan,
  type KitScope,
  overrideDir,
  serverArgs,
} from "../kit-types.ts";
import {
  childArray,
  childObject,
  editJsonFile,
  isJsonObject,
  type JsonObject,
  jsonAt,
} from "../plan-files.ts";
import { OWNER_COMMANDS } from "../steer-table.ts";

const KIT = "claude-code";

/** `Bash(nimbus approvals *)`: a trailing ` *` also matches the bare command. */
export const CLAUDE_DENY_RULES: readonly string[] = OWNER_COMMANDS.map(
  (c) => `Bash(${c.join(" ")} *)`,
);

const HOOK_ARGS = ["agent", "hook", KIT] as const;

function hookGroup(nimbus: string): JsonObject {
  return {
    matcher: "Bash|PowerShell",
    hooks: [{ type: "command", command: nimbus, args: [...HOOK_ARGS] }],
  };
}

/** True for a hook group a Nimbus kit wrote: one of its handlers runs `<x> agent hook claude-code`. */
function isNimbusHookGroup(group: unknown): boolean {
  if (!isJsonObject(group) || !Array.isArray(group["hooks"])) return false;
  return group["hooks"].some((h) => {
    if (!isJsonObject(h) || !Array.isArray(h["args"])) return false;
    const args = h["args"];
    return args.length === HOOK_ARGS.length && HOOK_ARGS.every((a, i) => args[i] === a);
  });
}

function editSettings(before: string | null, path: string, nimbus: string): string {
  return editJsonFile(before, path, (root) => {
    const pre = childArray(childObject(root, "hooks", path), "PreToolUse", path);
    const mine = pre.findIndex(isNimbusHookGroup);
    if (mine === -1) pre.push(hookGroup(nimbus));
    else pre[mine] = hookGroup(nimbus);
    const deny = childArray(childObject(root, "permissions", path), "deny", path);
    for (const rule of CLAUDE_DENY_RULES) {
      if (!deny.includes(rule)) deny.push(rule);
    }
  });
}

/** True when the settings already hold the kit's hook or one of its deny rules. */
function settingsHoldKit(before: string): boolean {
  const pre = jsonAt(before, ["hooks", "PreToolUse"]);
  const deny = jsonAt(before, ["permissions", "deny"]);
  return (
    (Array.isArray(pre) && pre.some(isNimbusHookGroup)) ||
    (Array.isArray(deny) && CLAUDE_DENY_RULES.some((r) => deny.includes(r)))
  );
}

const hasServer = (before: string): boolean =>
  jsonAt(before, ["mcpServers", "nimbus"]) !== undefined;

function editMcp(before: string | null, path: string, nimbus: string): string {
  return editJsonFile(before, path, (root) => {
    childObject(root, "mcpServers", path)["nimbus"] = { command: nimbus, args: serverArgs(KIT) };
  });
}

export function planClaudeCode(env: KitEnv, scope: KitScope): KitPlan {
  if (scope === "project") {
    assertProject(env, join(env.cwd, ".git"));
    const mcp = join(env.cwd, ".mcp.json");
    const settings = join(env.cwd, ".claude", "settings.json");
    return {
      kit: KIT,
      scope,
      files: [
        fileEdit(env, env.cwd, mcp, "mcp", (b) => editMcp(b, mcp, env.nimbus), hasServer),
        fileEdit(
          env,
          env.cwd,
          settings,
          "steer",
          (b) => editSettings(b, settings, env.nimbus),
          settingsHoldKit,
        ),
      ],
      manual: [],
      enforcement: "hook",
      notes: [],
    };
  }
  const override = overrideDir(env, "CLAUDE_CONFIG_DIR");
  const configDir = override ?? join(env.home, ".claude");
  const root = override === undefined ? env.home : dirname(override);
  const settings = join(configDir, "settings.json");
  return {
    kit: KIT,
    scope,
    files: [
      fileEdit(
        env,
        root,
        settings,
        "steer",
        (b) => editSettings(b, settings, env.nimbus),
        settingsHoldKit,
      ),
    ],
    manual: [
      {
        component: "mcp",
        why: "Claude Code keeps user-scope MCP servers in a file it writes for itself, so add the server with its own command",
        argv: [
          "claude",
          "mcp",
          "add",
          "--scope",
          "user",
          "nimbus",
          "--",
          env.nimbus,
          ...serverArgs(KIT),
        ],
      },
    ],
    enforcement: "hook",
    notes: [],
  };
}

/**
 * The VS Code (Copilot) kit (Phase 28 AD7b).
 *
 * Read from code.visualstudio.com/docs on 2026-11-15:
 *  - user: `$COPILOT_HOME/mcp-config.json` or `~/.copilot/mcp-config.json`, top-level `mcpServers`,
 *    the documented example carrying `"tools": ["*"]`;
 *  - project: `.vscode/mcp.json`, top-level `servers`. The docs call this the Local harness and say
 *    it goes away in February 2027. The kit uses it because the current workspace file, `.mcp.json`,
 *    is the one the Claude Code kit owns: two kits must never share one key.
 *  - `.github/copilot-instructions.md` is read as instructions.
 *
 * GUIDANCE ONLY: terminal auto-approve rules ask rather than block, and the hook file location for
 * the current harness was not read.
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
import { childObject, editJsonFile, hasBlock, jsonAt, upsertBlock } from "../plan-files.ts";
import { renderInstructions, STEER_TABLE_VERSION } from "../steer-table.ts";
import { NO_USER_STEERING } from "./cursor.ts";

const KIT = "vscode";

export const VSCODE_LOCAL_HARNESS_NOTE =
  ".vscode/mcp.json is VS Code's Local harness format, which its documentation says is removed in February 2027";

export function planVscode(env: KitEnv, scope: KitScope): KitPlan {
  if (scope === "user") {
    const override = overrideDir(env, "COPILOT_HOME");
    const dir = override ?? join(env.home, ".copilot");
    const root = override === undefined ? env.home : dirname(override);
    const mcp = join(dir, "mcp-config.json");
    return {
      kit: KIT,
      scope,
      files: [
        fileEdit(
          env,
          root,
          mcp,
          "mcp",
          (b) =>
            editJsonFile(b, mcp, (root) => {
              childObject(root, "mcpServers", mcp)["nimbus"] = {
                type: "stdio",
                command: env.nimbus,
                args: serverArgs(KIT),
                tools: ["*"],
              };
            }),
          (b) => jsonAt(b, ["mcpServers", "nimbus"]) !== undefined,
        ),
      ],
      manual: [],
      enforcement: "none",
      notes: [NO_USER_STEERING],
    };
  }
  assertProject(env, join(env.cwd, ".git"));
  const mcp = join(env.cwd, ".vscode", "mcp.json");
  const instructions = join(env.cwd, ".github", "copilot-instructions.md");
  return {
    kit: KIT,
    scope,
    files: [
      fileEdit(
        env,
        env.cwd,
        mcp,
        "mcp",
        (b) =>
          editJsonFile(b, mcp, (root) => {
            childObject(root, "servers", mcp)["nimbus"] = {
              type: "stdio",
              command: env.nimbus,
              args: serverArgs(KIT),
            };
          }),
        (b) => jsonAt(b, ["servers", "nimbus"]) !== undefined,
      ),
      fileEdit(
        env,
        env.cwd,
        instructions,
        "instructions",
        (b) => upsertBlock(b, KIT, STEER_TABLE_VERSION, renderInstructions(), "html"),
        (b) => hasBlock(b, KIT, "html"),
      ),
    ],
    manual: [],
    enforcement: "guidance only",
    notes: [VSCODE_LOCAL_HARNESS_NOTE],
  };
}

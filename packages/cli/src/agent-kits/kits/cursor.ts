/**
 * The Cursor kit (Phase 28 AD7b).
 *
 * Read from cursor.com/docs on 2026-11-15: `~/.cursor/mcp.json` and `.cursor/mcp.json` hold
 * `{"mcpServers":{"<name>":{"type":"stdio","command":..,"args":[..]}}}`; rules are
 * `.cursor/rules/*.mdc` with `alwaysApply: true` front matter and exist per project only.
 *
 * GUIDANCE ONLY. Cursor has a `beforeShellExecution` hook, but the shape of what it sends was read
 * from a summary, and a hook that misreads its input blocks every command or none. It is not
 * installed until that shape is confirmed against a real Cursor.
 */
import { join } from "node:path";

import {
  assertProject,
  fileEdit,
  type KitEnv,
  type KitPlan,
  type KitScope,
  serverArgs,
} from "../kit-types.ts";
import {
  childObject,
  editJsonFile,
  findBlock,
  hasBlock,
  jsonAt,
  KitRefusal,
  normaliseNewlines,
  upsertBlock,
} from "../plan-files.ts";
import { renderInstructions, STEER_TABLE_VERSION } from "../steer-table.ts";

const KIT = "cursor";

export const NO_USER_STEERING =
  "no steering at user scope; run with --scope project inside a repository to add the instructions file";

const FRONT_MATTER = "---\nalwaysApply: true\n---\n\n";

const hasServer = (before: string): boolean =>
  jsonAt(before, ["mcpServers", "nimbus"]) !== undefined;

function editMcp(before: string | null, path: string, nimbus: string): string {
  return editJsonFile(before, path, (root) => {
    childObject(root, "mcpServers", path)["nimbus"] = {
      type: "stdio",
      command: nimbus,
      args: serverArgs(KIT),
    };
  });
}

/**
 * `.cursor/rules/nimbus.mdc` is a file the kit owns whole (front matter must be the first thing in
 * it). A file of that name Nimbus did not write is refused, never taken over.
 */
function editRules(before: string | null, path: string): string {
  if (before !== null && findBlock(normaliseNewlines(before), KIT, "html") === undefined) {
    throw new KitRefusal(`${path} exists and Nimbus did not write it; move it aside first`);
  }
  const text =
    FRONT_MATTER + upsertBlock(null, KIT, STEER_TABLE_VERSION, renderInstructions(), "html");
  // The file is owned whole, but it keeps the line ending it has on disk.
  return before?.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
}

export function planCursor(env: KitEnv, scope: KitScope): KitPlan {
  if (scope === "user") {
    const mcp = join(env.home, ".cursor", "mcp.json");
    return {
      kit: KIT,
      scope,
      files: [fileEdit(env, env.home, mcp, "mcp", (b) => editMcp(b, mcp, env.nimbus), hasServer)],
      manual: [],
      enforcement: "none",
      notes: [NO_USER_STEERING],
    };
  }
  assertProject(env, join(env.cwd, ".git"));
  const mcp = join(env.cwd, ".cursor", "mcp.json");
  const rules = join(env.cwd, ".cursor", "rules", "nimbus.mdc");
  return {
    kit: KIT,
    scope,
    files: [
      fileEdit(env, env.cwd, mcp, "mcp", (b) => editMcp(b, mcp, env.nimbus), hasServer),
      fileEdit(
        env,
        env.cwd,
        rules,
        "instructions",
        (b) => editRules(b, rules),
        (b) => hasBlock(b, KIT, "html"),
      ),
    ],
    manual: [],
    enforcement: "guidance only",
    notes: [],
  };
}

/**
 * Taking a kit out again (`nimbus agent uninstall`). Pure, like install: a plan, no file system.
 *
 * The mirror of install, and no wider. It removes ONLY what a kit wrote:
 *  - an owned block, and only when its body still matches the hash its marker carries. A block
 *    someone edited is REFUSED (nothing is changed, the message says how to finish by hand):
 *    deleting it would delete the owner's lines, and "remove it anyway" is not Nimbus's call;
 *  - owned JSON keys: the `nimbus` server entry when it is the one a kit writes (its arguments are
 *    the kit's own), the kit's hook handler (a hook group that also holds the owner's handlers
 *    keeps them), and the kit's deny rules. An entry that is not the kit's is left and reported.
 *    A rule or entry byte-equal to what the kit adds counts as the kit's even if the owner had
 *    written the same text first: install did not record which.
 * A file the kit named (`nimbus.rules`, `nimbus.mdc`) that holds nothing else afterwards is deleted,
 * after its backup is made; every other file is kept, even when it is left empty.
 * Which files are looked at is whatever install would plan for that kit and scope, so a kit
 * cannot be uninstalled from a place it could not have been installed.
 */
import {
  assertWritableTarget,
  type FileEdit,
  type KitEnv,
  type KitId,
  type KitPlan,
  type KitScope,
  serverArgs,
} from "./kit-types.ts";
import { CLAUDE_DENY_RULES, isNimbusHandler, isNimbusHookGroup } from "./kits/claude-code.ts";
import { planKit } from "./kits/index.ts";
import {
  editJsonFile,
  isJsonObject,
  type JsonObject,
  normaliseNewlines,
  removeBlock,
  sameText,
} from "./plan-files.ts";

interface Removal {
  readonly after: string;
  /** Delete the file: it is Nimbus-named and nothing else is left in it. */
  readonly remove?: boolean;
}

/** Nimbus-named files: a kit owns the whole file, so an emptied one goes rather than lingers. */
const CURSOR_FRONT_MATTER = "---\nalwaysApply: true\n---";

function sameArgs(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && b.every((w, i) => a[i] === w);
}

/** Drops `key` from `parent` when the removal just emptied it. */
function dropIfEmpty(parent: JsonObject, key: string): void {
  const v = parent[key];
  const empty = Array.isArray(v) ? v.length === 0 : isJsonObject(v) && Object.keys(v).length === 0;
  if (empty) delete parent[key];
}

/** Takes the kit's `nimbus` server entry out of `root[holder]`; false when it is not the kit's. */
function removeServer(root: JsonObject, holder: string, kit: KitId, notes: string[], path: string) {
  const servers = root[holder];
  if (!isJsonObject(servers) || servers["nimbus"] === undefined) return;
  const entry = servers["nimbus"];
  if (!isJsonObject(entry) || !sameArgs(entry["args"], serverArgs(kit))) {
    notes.push(
      `${path}: the "nimbus" server entry is not one Nimbus wrote, so it was left as it is`,
    );
    return;
  }
  delete servers["nimbus"];
  dropIfEmpty(root, holder);
}

function removeClaudeHook(root: JsonObject): void {
  const hooks = root["hooks"];
  const pre = isJsonObject(hooks) ? hooks["PreToolUse"] : undefined;
  if (!isJsonObject(hooks) || !Array.isArray(pre) || !pre.some(isNimbusHookGroup)) return;
  const kept: unknown[] = [];
  for (const group of pre) {
    if (!isNimbusHookGroup(group)) {
      kept.push(group);
      continue;
    }
    const rest = (group as { hooks: unknown[] }).hooks.filter((h) => !isNimbusHandler(h));
    if (rest.length > 0) kept.push({ ...(group as JsonObject), hooks: rest });
  }
  pre.splice(0, pre.length, ...kept);
  dropIfEmpty(hooks, "PreToolUse");
  dropIfEmpty(root, "hooks");
}

function removeClaudeDeny(root: JsonObject): void {
  const permissions = root["permissions"];
  const deny = isJsonObject(permissions) ? permissions["deny"] : undefined;
  if (!isJsonObject(permissions) || !Array.isArray(deny)) return;
  const kept = deny.filter((r) => !CLAUDE_DENY_RULES.includes(r as string));
  if (kept.length === deny.length) return;
  deny.splice(0, deny.length, ...kept);
  dropIfEmpty(permissions, "deny");
  dropIfEmpty(root, "permissions");
}

function removeJson(
  before: string,
  path: string,
  mutate: (root: JsonObject) => void,
): Removal | undefined {
  const after = editJsonFile(before, path, mutate);
  return after === before ? undefined : { after };
}

/** Cursor's rules file: the kit owns it whole, so only a file with nothing else left is deleted. */
function removeCursorRules(before: string, path: string): Removal | undefined {
  const after = removeBlock(before, "cursor", "html", path);
  if (after === undefined) return undefined;
  const rest = normaliseNewlines(after).trim();
  return rest === "" || rest === CURSOR_FRONT_MATTER ? { after: "", remove: true } : { after };
}

/** A block file the kit names whole (`nimbus.rules`): deleted when the block was all it held. */
function removeRulesFile(before: string, path: string): Removal | undefined {
  const after = removeBlock(before, "codex", "hash", path);
  if (after === undefined) return undefined;
  return after.trim() === "" ? { after: "", remove: true } : { after };
}

function removeTextBlock(
  before: string,
  kit: string,
  style: "hash" | "html",
  path: string,
): Removal | undefined {
  const after = removeBlock(before, kit, style, path);
  return after === undefined ? undefined : { after };
}

function removalFor(
  kit: KitId,
  scope: KitScope,
  edit: FileEdit,
  before: string,
  notes: string[],
): Removal | undefined {
  const { path, component } = edit;
  switch (kit) {
    case "claude-code":
      return component === "mcp"
        ? removeJson(before, path, (r) => removeServer(r, "mcpServers", kit, notes, path))
        : removeJson(before, path, (r) => {
            removeClaudeHook(r);
            removeClaudeDeny(r);
          });
    case "codex":
      if (component === "mcp") return removeTextBlock(before, kit, "hash", path);
      return component === "steer"
        ? removeRulesFile(before, path)
        : removeTextBlock(before, kit, "html", path);
    case "cursor":
      return component === "mcp"
        ? removeJson(before, path, (r) => removeServer(r, "mcpServers", kit, notes, path))
        : removeCursorRules(before, path);
    case "vscode":
      return component === "mcp"
        ? removeJson(before, path, (r) =>
            removeServer(r, scope === "user" ? "mcpServers" : "servers", kit, notes, path),
          )
        : removeTextBlock(before, kit, "html", path);
  }
}

/**
 * What uninstalling `kit` at `scope` would change: one edit per file that holds something of the
 * kit's (a file that does not, or does not exist, is not in the plan), the command the owner runs
 * for a part Nimbus never wrote itself, and notes for anything left on purpose. Throws
 * `KitRefusal` for a target install would refuse, a file that cannot be read as the kit's, and a
 * block edited by hand; nothing is partly planned.
 */
export function planKitRemoval(kit: KitId, env: KitEnv, scope: KitScope): KitPlan {
  // Tolerant planning: install's own content refusals (a foreign Codex table, say) must not stop
  // us from taking our block out. The paths, roots and components are what is wanted here.
  const installed = planKit(kit, { ...env, tolerant: true }, scope);
  const notes: string[] = [];
  const files: FileEdit[] = [];
  for (const f of installed.files) {
    assertWritableTarget(env.kind, f.root, f.path);
    const before = env.read(f.path);
    if (before === null) continue;
    const removal = removalFor(kit, scope, f, before, notes);
    if (removal === undefined || sameText(before, removal.after)) continue;
    files.push({
      path: f.path,
      component: f.component,
      before,
      after: removal.after,
      present: true,
      root: f.root,
      ...(removal.remove === true ? { remove: true } : {}),
    });
  }
  const manual = installed.manual.map((m) => ({
    ...m,
    why: "Claude Code keeps user-scope MCP servers in a file it writes for itself, so remove the server with its own command",
    argv: ["claude", "mcp", "remove", "--scope", "user", "nimbus"],
  }));
  return { kit, scope, files, manual, enforcement: installed.enforcement, notes };
}

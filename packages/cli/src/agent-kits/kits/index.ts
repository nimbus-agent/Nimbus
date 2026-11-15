import type { KitEnv, KitId, KitPlan, KitScope } from "../kit-types.ts";
import { planClaudeCode } from "./claude-code.ts";
import { planCodex } from "./codex.ts";
import { planCursor } from "./cursor.ts";
import { planVscode } from "./vscode.ts";

const PLANNERS: Record<KitId, (env: KitEnv, scope: KitScope) => KitPlan> = {
  "claude-code": planClaudeCode,
  codex: planCodex,
  cursor: planCursor,
  vscode: planVscode,
};

/** The scope `nimbus agent install <kit>` uses when none is given. */
export const DEFAULT_SCOPE: Record<KitId, KitScope> = {
  "claude-code": "user",
  codex: "user",
  cursor: "user",
  vscode: "project",
};

/** The scopes each kit can be installed at (Codex has no project scope Nimbus can rely on). */
export const SUPPORTED_SCOPES: Record<KitId, readonly KitScope[]> = {
  "claude-code": ["user", "project"],
  codex: ["user"],
  cursor: ["user", "project"],
  vscode: ["user", "project"],
};

/** What installing `kit` at `scope` would write. Throws `KitRefusal` with a fixed message. */
export function planKit(kit: KitId, env: KitEnv, scope: KitScope): KitPlan {
  return PLANNERS[kit](env, scope);
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The auditor's entry point; the rules themselves live in `invariants/` beside it. */
export const INVARIANTS_ENTRY_REL = "scripts/structure-audit/check-nimbus-invariants.ts";
const INVARIANTS_DIR_REL = "scripts/structure-audit/invariants";

/**
 * The text of the whole static invariant auditor: the entry point followed by every module under
 * `invariants/`, in name order. Tests and `check-status-drift.ts` read the auditor's SOURCE to pin
 * what it names (a rule id, a wiring line, an allow-list); since the split they ask for it here,
 * so a pin does not care which module a rule lives in.
 */
export function readInvariantsSource(repoRoot: string): string {
  const dir = join(repoRoot, INVARIANTS_DIR_REL);
  const parts = [readFileSync(join(repoRoot, INVARIANTS_ENTRY_REL), "utf8")];
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
      .sort();
  } catch (err) {
    // No invariants/ directory (a fixture tree): the entry alone is the auditor. Any other failure
    // (EACCES, an I/O error) is rethrown: a ceiling computed from part of the auditor would be wrong.
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
  }
  for (const n of names) parts.push(readFileSync(join(dir, n), "utf8"));
  return parts.join("\n");
}

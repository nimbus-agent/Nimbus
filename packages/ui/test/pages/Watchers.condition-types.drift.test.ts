import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `packages/ui/src/pages/Watchers.tsx` duplicates the gateway's condition-type list rather than
 * importing it: `packages/ui` may reach the Gateway over IPC only and must never import Gateway
 * source. Nothing else detects the two lists drifting apart — a drift means the Create Watcher
 * dialog offers a `conditionType` the gateway's `watcher.create` rejects with `-32602`, or hides
 * one it would accept.
 *
 * This guard reads BOTH files as TEXT (not a source import — the dependency rule stays intact)
 * and compares the `conditionType` literals declared in
 * `packages/gateway/src/automation/watcher-condition-kinds.ts` against the `CONDITION_TYPES`
 * array literal declared in `packages/ui/src/pages/Watchers.tsx`.
 *
 * Paths are resolved from the module's own directory, never `process.cwd()` — a CWD-relative
 * read has previously gone ENOENT under a sharded CI runner and silently never run (see
 * `audit:import-meta-dir` / `scripts/structure-audit/check-import-meta-dir.ts`, and the sibling
 * guard `packages/gateway/src/embedding/embedding-body-source.guard.test.ts`, which use Bun's
 * `import.meta.dir`). This package's tests run under vitest on Node, not Bun, so the Bun-only
 * `import.meta.dir` is unavailable here; `import.meta.dirname` is Node's equivalent (Node
 * >=20.11) and resolves to this file's own directory the same way — never the process CWD.
 */

const GATEWAY_CONDITION_KINDS_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "gateway",
  "src",
  "automation",
  "watcher-condition-kinds.ts",
);

const UI_WATCHERS_PAGE_PATH = join(import.meta.dirname, "..", "..", "src", "pages", "Watchers.tsx");

/**
 * Reads `path` as text or fails loudly. A guard that cannot read its inputs must never silently
 * skip or pass — that is worse than no guard at all, because it reports green while proving
 * nothing.
 */
function readSourceOrFail(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `Watchers condition-type drift guard could not read "${path}": ${String(err)}. This guard ` +
        "compares packages/ui/src/pages/Watchers.tsx's CONDITION_TYPES against " +
        "packages/gateway/src/automation/watcher-condition-kinds.ts's WATCHER_CONDITION_KINDS " +
        "and cannot verify anything without both files. Fix the path (or restore the missing " +
        "file) — do not delete or skip this test.",
    );
  }
}

function extractGatewayConditionTypes(src: string): string[] {
  const matches = [...src.matchAll(/conditionType:\s*"([^"]+)"/g)];
  if (matches.length === 0) {
    throw new Error(
      'Watchers condition-type drift guard found zero `conditionType: "..."` entries in ' +
        "watcher-condition-kinds.ts — its shape changed and the guard's extraction regex no " +
        "longer matches. Update the regex in Watchers.condition-types.drift.test.ts, do not " +
        "delete this test.",
    );
  }
  return matches.map((m) => m[1] as string);
}

function extractUiConditionTypes(src: string): string[] {
  const arrayMatch = src.match(/const CONDITION_TYPES = \[([^\]]*)\]/);
  if (arrayMatch === null) {
    throw new Error(
      "Watchers condition-type drift guard could not find `const CONDITION_TYPES = [...]` in " +
        "Watchers.tsx — its shape changed and the guard's extraction regex no longer matches. " +
        "Update the regex in Watchers.condition-types.drift.test.ts, do not delete this test.",
    );
  }
  return [...arrayMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

describe("Watchers condition-type drift guard", () => {
  it("Watchers.tsx CONDITION_TYPES has exactly the gateway's WATCHER_CONDITION_KINDS conditionTypes", () => {
    const gatewaySrc = readSourceOrFail(GATEWAY_CONDITION_KINDS_PATH);
    const uiSrc = readSourceOrFail(UI_WATCHERS_PAGE_PATH);

    const gatewayTypes = extractGatewayConditionTypes(gatewaySrc);
    const uiTypes = extractUiConditionTypes(uiSrc);

    // Compared as sets, not sequences: WATCHER_CONDITION_KINDS's order is the engine's own
    // table order (not meaningful outside it), and CONDITION_TYPES's order is a UI presentation
    // choice (dropdown option order) — neither file promises to match the other's ordering, only
    // membership. Membership is what a rejected/hidden `conditionType` actually depends on.
    const gatewaySorted = [...gatewayTypes].sort();
    const uiSorted = [...uiTypes].sort();

    if (JSON.stringify(uiSorted) !== JSON.stringify(gatewaySorted)) {
      throw new Error(
        `Watchers condition-type drift: packages/ui/src/pages/Watchers.tsx CONDITION_TYPES is ` +
          `${JSON.stringify(uiTypes)} but packages/gateway/src/automation/watcher-condition-kinds.ts ` +
          `WATCHER_CONDITION_KINDS conditionTypes are ${JSON.stringify(gatewayTypes)}. The Create ` +
          "Watcher dialog would offer a condition watcher.create rejects, or hide one it accepts. " +
          "Fix: update CONDITION_TYPES in Watchers.tsx to match WATCHER_CONDITION_KINDS in " +
          "watcher-condition-kinds.ts (or fix whichever list is wrong).",
      );
    }

    expect(uiSorted).toEqual(gatewaySorted);
  });
});

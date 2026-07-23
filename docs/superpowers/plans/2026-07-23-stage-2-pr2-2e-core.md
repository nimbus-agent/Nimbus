# Stage 2 PR 2 — 2e-core: Restricted-Mode fix + native welcome views

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Declare `capabilities.untrustedWorkspaces` and `extensionKind` (today VS Code silently disables the extension in Restricted Mode), and replace the lone "Not connected" tree row with native `viewsWelcome` content across the five sidebar views.

**Architecture:** Manifest-first: the fix is mostly `package.json` `contributes`/top-level fields, pinned by a manifest-contract unit test so a future edit can't silently drop them. One behavior change in `src/sidebar/tree-view.ts`: `connectionPlaceholder` returns `[]` for `disconnected`/`idle` so VS Code renders the `viewsWelcome` content (welcome only shows for an empty tree); `connecting`/`permission-denied` keep their informative rows, which deliberately suppress the generic welcome.

**Tech Stack:** as PR 1 (repo `C:\gitrep\nimbus-vscode`, vitest, Biome, esbuild).

## Global Constraints

- Branch `dev/asafgolombek/stage2-pr2-2e-core` in a worktree under `.claude/worktrees/`; `bun install` first; never commit on `main`.
- Full gate set before first push: `typecheck`, `bunx biome check .`, `test`, `build`, `check-bundle`, `check-settings-docs`, `package` + `check-vsix-contents`.
- The existing `nimbus.connected` context key (`src/extension.ts` `setContext`) is the `viewsWelcome` `when`-clause source — do not invent a new key.

---

### Task 1: Manifest declarations (test-first)

**Files:**

- Create: `test/unit/manifest-capabilities.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produces: top-level `extensionKind: ["ui"]`; `capabilities.untrustedWorkspaces = { supported: "limited", description, restrictedConfigurations: ["nimbus.socketPath", "nimbus.autoStartGateway"] }`; `contributes.viewsWelcome` with one entry per sidebar view id (`nimbus.auditView`, `nimbus.egressView`, `nimbus.agentsView`, `nimbus.indexView`, `nimbus.sessionsView`), each `when: "!nimbus.connected"` and contents linking `command:nimbus.startGateway` + `command:nimbus.troubleshootConnection`.

- [ ] **Step 1: Write the failing manifest-contract test**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const VIEW_IDS = [
  "nimbus.auditView",
  "nimbus.egressView",
  "nimbus.agentsView",
  "nimbus.indexView",
  "nimbus.sessionsView",
];

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));

describe("extension manifest: restricted-mode + remote + welcome declarations", () => {
  test("untrustedWorkspaces is declared as limited with the dangerous settings restricted", () => {
    const uw = manifest.capabilities?.untrustedWorkspaces;
    expect(uw?.supported).toBe("limited");
    expect(uw?.restrictedConfigurations).toEqual(
      expect.arrayContaining(["nimbus.socketPath", "nimbus.autoStartGateway"]),
    );
    expect(typeof uw?.description).toBe("string");
  });

  test("extensionKind pins the extension to the UI host (the gateway is local)", () => {
    expect(manifest.extensionKind).toEqual(["ui"]);
  });

  test("every sidebar view has a not-connected welcome with start/troubleshoot actions", () => {
    const entries = manifest.contributes?.viewsWelcome ?? [];
    for (const id of VIEW_IDS) {
      const entry = entries.find((e: { view: string }) => e.view === id);
      expect(entry, `viewsWelcome missing for ${id}`).toBeDefined();
      expect(entry.when).toBe("!nimbus.connected");
      expect(entry.contents).toContain("command:nimbus.startGateway");
      expect(entry.contents).toContain("command:nimbus.troubleshootConnection");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** (`bunx vitest run test/unit/manifest-capabilities.test.ts` → 3 FAIL)

- [ ] **Step 3: Add the manifest fields**

Top-level (after `"engines"`): `"extensionKind": ["ui"]` and

```json
"capabilities": {
  "untrustedWorkspaces": {
    "supported": "limited",
    "description": "In Restricted Mode the workspace-level socketPath and autoStartGateway settings are ignored (a workspace could otherwise redirect the IPC socket or spawn a process). Everything else works.",
    "restrictedConfigurations": ["nimbus.socketPath", "nimbus.autoStartGateway"]
  }
}
```

`contributes.viewsWelcome`: five entries, one per view id, each:

```json
{
  "view": "nimbus.auditView",
  "contents": "The Nimbus Gateway is not connected.\n[Start Gateway](command:nimbus.startGateway)\n[Troubleshoot](command:nimbus.troubleshootConnection)\nLocal-first: your data never leaves this machine.",
  "when": "!nimbus.connected"
}
```

- [ ] **Step 4: Run to verify it passes; commit** (`feat(manifest): declare untrustedWorkspaces, extensionKind, viewsWelcome`)

---

### Task 2: Empty tree on disconnected/idle so the welcome renders

**Files:**

- Modify: `src/sidebar/tree-view.ts` (`connectionPlaceholder`)
- Modify: `test/unit/sidebar-views.test.ts` (pins the old row)
- Modify: `test/unit/extension.test.ts` if any test asserts the "Not connected — click to reconnect" row

**Interfaces:**

- `connectionPlaceholder(state)` now returns `[]` for `kind === "disconnected"` and `"idle"` (welcome takes over), keeps the `connecting`/`starting-gateway` row and the `permission-denied` row, still `undefined` when connected.

- [ ] **Step 1: Update the pinning tests** — in `test/unit/sidebar-views.test.ts` change the disconnected/idle expectations from the "Not connected — click to reconnect" row to `[]`, with a comment that the empty tree is load-bearing: it is what makes VS Code show the `viewsWelcome` content. Keep (or add) assertions that `connecting` and `permission-denied` still render rows.

- [ ] **Step 2: Run to verify the changed tests fail** against the current implementation.

- [ ] **Step 3: Implement** — in `connectionPlaceholder`, `disconnected` and `idle` return `[]`; add the comment: "Empty (not a row): an empty tree is what lets VS Code render the viewsWelcome content for `!nimbus.connected`, which carries the start/troubleshoot buttons."

- [ ] **Step 4: Full unit suite + typecheck; commit** (`feat(sidebar): empty tree when down so viewsWelcome renders`)

---

### Task 3: Full gates, push, PR

As PR 1's Task 4 (all gates incl. `package` + `check-vsix-contents`, whole-branch review, push, `gh pr create`). PR body: the silent Restricted-Mode disablement fix is the headline; note `extensionKind: ["ui"]` rationale (gateway is machine-local) and the welcome-view swap with its empty-tree mechanism.

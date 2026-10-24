# Review: Role Packs P1 — PR 5 (Agent Visibility and the Catalog)

**Reviewed plan:** [2026-10-24-role-packs-p1-pr5-agent-visibility-catalog.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-24-role-packs-p1-pr5-agent-visibility-catalog.md)  
**Parent spec:** [2026-10-22-role-packs-p1-foundations-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md) § 5.5, § 6, § 7, § 8 calls 6, 8, 11, 13, 14  
**Date:** 2026-10-24  

---

## Executive Summary

PR 5 delivers the presentation layer of Role Packs Phase 1:
1. `[agents] visible` joins `PACK_SETTABLE_LISTS` as the first list key, unioned across active pack layers without scalar conflicts.
2. The owner can selectively show or hide individual agents in user layers (`base` and `profile`), with user decisions resolving per agent and `profile` overriding `base`.
3. The presentation-only boundary is strictly preserved: no gate, dispatcher, HTTP route, MCP tool, fleet scheduler, or ChatOps path reads visibility.
4. A unified catalog (`catalog.list` and `nimbus catalog`) lists all 17 built-in agents and 101 built-in connectors alongside owner-added extensions and user MCP servers, complete with descriptive metadata, parameter descriptors, and visibility indicators.

Cross-checking the plan against the live codebase (including `origin/main` and stacked branch `dev/asaf/role-packs-p1-merging` containing PR 1 through PR 4) confirms the plan's architectural elegance and feasibility while uncovering **5 implementation traps / edge cases to guard against**, **4 open questions / design clarifications**, and **5 concrete implementation refinements**.

---

## 1. Implementation Traps & Edge Cases to Guard Against (Must-Address)

### 1.1 `parseAgentNameList` Strictness vs. Valid TOML Whitespace & Trailing Commas (Task 1)

In Task 1:
> Produces: `export function parseAgentNameList(valRaw: string): readonly string[] | undefined`.  
> *"It is strict: a `[`…`]` array of 1..64 double-quoted strings, each matching `AGENT_NAME_IN_LIST_RE`, comma-separated, with no trailing comma. Anything else returns `undefined`. Names are returned as written; normalisation is Task 2's job."*

**The Trap:**
1. In TOML, elements inside arrays commonly contain surrounding whitespace: `[ "decisions", "standup" ]`.
2. `parseString` in `toml-primitives.ts:68` unquotes strings, but does **not** validate double quotes—it returns unquoted tokens verbatim if no quotes surround them (`parseString("decisions") === "decisions"`).
3. If an implementation naively splits by comma and calls `parseString`, it might mistakenly accept unquoted strings (e.g. `[decisions, standup]`) or fail to reject trailing commas (e.g. `["decisions",]`).

**Recommendation:**
Implement `parseAgentNameList` with explicit checks:
```ts
export function parseAgentNameList(valRaw: string): readonly string[] | undefined {
  const trimmed = valRaw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "" || inner.endsWith(",")) return undefined; // Non-empty, no trailing comma

  const parts = inner.split(",");
  if (parts.length === 0 || parts.length > 64) return undefined;

  const names: string[] = [];
  for (const part of parts) {
    const p = part.trim();
    // Must be explicitly double-quoted
    if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return undefined;
    const unquoted = p.slice(1, -1);
    if (!AGENT_NAME_IN_LIST_RE.test(unquoted)) return undefined;
    names.push(unquoted);
  }
  return names;
}
```

---

### 1.2 `EffectiveDoc` Section Lookup & `shadowed` Deduplication (Task 2)

In Task 2:
> *"Algorithm: find the non-array `agents` section in `snapshot.doc.sections`. For each of `visible`/`show`/`hide`, the per-layer values are `[...entry.shadowed, last winner entry]`, already ordered low to high."*

**The Traps:**
1. **Missing Section:** If no layer sets any `[agents]` keys, `snapshot.doc.sections` contains no section where `header === "agents"`. `resolveAgentVisibility` must guard against `section === undefined` and return immediately:
   ```ts
   if (section === undefined) {
     return { visible: new Set(known), basis: "all", packs: [], overrides: [], notes: [] };
   }
   ```
2. **Duplicate Winner Entries in `section.entries`:**
   In `layered-merge.ts:155-160`, if a user file defines `show = [...]` on multiple lines, `section.entries` contains *multiple* `EffectiveEntry` objects for the same key, each holding an identical copy of `entry.shadowed`.
   - Iterating over `section.entries.filter(e => e.key === key)` would duplicate the lower layers' values from `shadowed`.
   - **Fix:** Always take `section.entries.findLast(e => e.key === key)` (or `find`) to extract `shadowed` exactly once and combine with the last winner entry.
3. **Deduplicating Pack Names:**
   If the same pack layer is read or malformed duplicate entries occur, pack IDs collected in `packs` must be deduped while maintaining low-to-high layer order.

---

### 1.3 `parseStringArray` Exception Handling on Malformed User `show`/`hide` (Task 2)

In Task 2:
> *"Consumes: ... `parseStringArray` (`config/toml-primitives.ts`) for USER layers."*  
> *"Note texts, verbatim: `[agents] <key> in <kind>:<id> is not an array of agent names; ignored`"*

**The Trap:**
In `packages/gateway/src/config/toml-primitives.ts:121-123`:
```ts
export function parseStringArray(raw: string): string[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new TypeError(`expected array, got: ${raw}`);
  }
  ...
```
`parseStringArray` throws a `TypeError` on any non-array value (e.g. `show = "decisions"` or `hide = 42`).
- If unhandled, this would bubble up and fail the whole catalog list or diagnostics call.
- **Fix:** Wrap `parseStringArray(valRaw)` in a `try...catch` block. On catch, record the verbatim note:
  `[agents] ${key} in ${layer.kind}:${layer.id} is not an array of agent names; ignored` and skip that entry.

---

### 1.4 Missing Files in Task 6: CLI Command Registry & Dispatch Table

In Task 6:
> **Files:**
> - Modify: `packages/cli/src/index.ts` (`COMMAND_HANDLERS`), `packages/cli/src/commands/help.ts`...

**The Trap:**
1. In `packages/cli/src/commands/registry.ts`, `COMMAND_NAMES` defines the canonical tuple of all CLI commands.
2. In `packages/cli/src/commands/registry.test.ts:83-87`:
   ```ts
   const registered = new Set<string>(COMMAND_NAMES);
   ...
   `dispatched in index.ts but absent from COMMAND_NAMES: ${missing.join(", ")}`
   ```
   A structural test explicitly fails if any handler registered in `COMMAND_HANDLERS` in `packages/cli/src/index.ts` is missing from `COMMAND_NAMES` in `registry.ts`.
3. `packages/cli/src/index.ts` imports handlers through `packages/cli/src/commands/index.ts`.

**Recommendation:**
Add the following files to Task 6's modify list:
- Modify: [packages/cli/src/commands/registry.ts](file:///C:/gitrep/Nimbus/packages/cli/src/commands/registry.ts) (add `"catalog"` to `COMMAND_NAMES` in alphabetical order).
- Modify: [packages/cli/src/commands/index.ts](file:///C:/gitrep/Nimbus/packages/cli/src/commands/index.ts) (export `runCatalog` from `./catalog.ts`).
- Modify: [packages/cli/src/commands/registry.test.ts](file:///C:/gitrep/Nimbus/packages/cli/src/commands/registry.test.ts) (assert `COMMAND_NAMES` contains `"catalog"`).

---

### 1.5 `tryDispatchCatalogRpc` Handling of `configDir === undefined` (Task 5)

In Task 5:
> `dispatchCatalogRpc(method, params, ctx: { readonly db: Database; readonly configDir: string })`  
> `tryDispatchCatalogRpc` throws `-32603`, `catalog.list requires LocalIndex`, when `localIndex` is absent, mirroring `tryDispatchLocalityRpc`.

**The Trap:**
In `packages/gateway/src/ipc/server/dispatchers.ts`, `ctx.options.configDir` has type `string | undefined`.
- If `localIndex` is present but `configDir` is `undefined` (which can occur in test harnesses or minimal server configurations), passing `ctx.options.configDir` into `dispatchCatalogRpc` fails TypeScript compilation under `strict: true`.
- Other dispatchers (such as `tryDispatchPreflightRpc` in `dispatchers.ts:540`) guard this explicitly:
  ```ts
  if (ctx.options.configDir === undefined) {
    throw new RpcMethodError(-32603, "configDir is required for catalog.* RPCs");
  }
  ```

**Recommendation:**
In `tryDispatchCatalogRpc`, assert `configDir !== undefined` and throw `-32603` if missing:
```ts
if (ctx.options.localIndex === undefined) {
  throw new RpcMethodError(-32603, "catalog.list requires LocalIndex");
}
if (ctx.options.configDir === undefined) {
  throw new RpcMethodError(-32603, "configDir is required for catalog.list");
}
```

---

## 2. Open Questions & Architectural Clarifications

### 2.1 Scope of `agentVisibilityNotes` Callback: Behavior on `path === undefined` vs. `agents` (Task 5)

In Task 5:
> `explainConfig`'s `opts` gains `readonly agentVisibilityNotes?: () => readonly string[]`.  
> *"It is called only when the path is `agents` or starts with `agents.`, and its lines are appended to `notes` after the fleet notes."*  
> Test: *"other paths do not call agentVisibilityNotes (the callback throws if called)."*

**Clarification:**
When an operator runs a bare `nimbus config explain` (where `path === undefined`), all effective sections are dumped.
- `fleetJobNotes` is called when `path === undefined` to summarize all fleet drops and stubs.
- In contrast, the plan restricts `agentVisibilityNotes` to `path === "agents" || path.startsWith("agents.")`.
- **Reasoning:** Calling `agentVisibilityNotes` on `path === undefined` would emit `agent visibility: all agents (no active pack sets [agents] visible)` on every global explain output, cluttering standard diagnostics for users who do not use packs.
- **Note on Quoting:** `path` can be passed quoted from the CLI (e.g. `"agents"` or `"agents.visible"`). The check in `explainConfig` must unquote `path` before testing:
  ```ts
  const target = path !== undefined ? unquote(path) : undefined;
  const isAgentsPath = target !== undefined && (target === "agents" || target.startsWith("agents."));
  ```

---

### 2.2 Normalised vs. Raw Agent Names in Diagnostic Note Messages (Task 2)

In Task 2:
> Note text: `unknown agent "<name>" in <kind>:<id> [agents] <key>`  
> Algorithm: *"Normalise every name, drop unknown names with a note, and dedupe."*

**Question:**
If a pack or base file writes `visible = ["agents.standpu"]`:
- If normalisation runs *before* checking against `known`, the note will report:
  `unknown agent "standpu" in pack:ops [agents] visible`
- If normalisation runs *after* (or if the note prints the input token), it would report:
  `unknown agent "agents.standpu" in pack:ops [agents] visible`

**Clarification:**
Following the plan's exact phrasing ("*Normalise every name, drop unknown names with a note*"), `<name>` in the note should be the **normalised name** (`"standpu"`). This guarantees that both bare (`"standpu"`) and prefixed (`"agents.standpu"`) typos produce identical, canonical diagnostic messages.

---

### 2.3 `oneOf` Group Modeling for Multi-Param Arms (`why.line`) (Task 3)

In Task 3:
> `export type CatalogParam = { readonly name: string; readonly kind: ParamKind; readonly label: string; readonly required: boolean; readonly oneOf?: { readonly group: string; readonly arm: string; readonly required: boolean } }`.  
> *"Members sharing a `group` are mutually exclusive. Members sharing `group` AND `arm` go together, like the forge triple. `required` on the param is `false` for every group member; the group's own `required` says whether one arm must be given."*  
> Test: *"oneOf groups are well formed: every group has at least two arms, and no group member is `required: true`."*

**The Ambiguity:**
Consider `why`:
- Arm 1: `{ ref, line }` (arm `"ref"`)
- Arm 2: `prUrl` (arm `"prUrl"`)
- Arm 3: `itemUrl` (arm `"itemUrl"`)

In Arm 1, `ref` is mandatory if Arm 1 is used, but `line` is optional (`line?: number`).
If the invariant enforces `param.required === false` on every param with a `oneOf` group, how does a client or UI know that `ref` is mandatory for that arm while `line` is optional?

**Recommendation:**
In `CatalogParam`, preserve `param.required === false` at the top level (since the group as a whole might not be chosen), but allow `armOptional?: boolean` inside `oneOf` (or document that within a multi-member arm, fields marked `armOptional: true` are optional even if that arm is selected):
```ts
export type CatalogParam = {
  readonly name: string;
  readonly kind: ParamKind;
  readonly label: string;
  readonly required: boolean;
  readonly oneOf?: {
    readonly group: string;
    readonly arm: string;
    readonly required: boolean;
    readonly armOptional?: boolean;
  };
};
```
For `why.line`, `armOptional: true` documents that `line` can be omitted even when the `ref` arm is supplied.

---

### 2.4 CLI Agents Table Column Value for Visible Rows (Task 6)

In Task 6:
> *"The agents table has the columns `name`, `shown`, `category` and `description`. A hidden agent shows `hidden`, and the visibility summary line comes first."*

**Clarification:**
What text should be printed in the `shown` column when an agent is visible?
- Options: `"shown"`, `"yes"`, `"visible"`, or `""` (blank for default visible, `"hidden"` for hidden).
- For maximum clarity and alignment with the column header `shown`:
  - A visible agent displays **`"shown"`** (or `"yes"`).
  - A hidden agent displays **`"hidden"`**.
- Pinning this in Task 6 avoids test assertions failing due to formatting divergence.

---

## 3. Concrete Implementation Refinements

### 3.1 `checkCatalogParams` Short-Name vs. `BriefMethod` Key Tolerance (Task 3)

In Task 3:
> `checkCatalogParams(parsed, catalog: Readonly<Record<string, readonly { name: string; kind: ParamKind }[]>>)`

In `scripts/structure-audit/check-agent-param-kinds.ts`:
- `ParsedValidator.agent` is derived as a short name (e.g. `"catchup"`, `"decisions"`).
- `AGENT_CATALOG` in `packages/gateway/src/catalog/agent-catalog.ts` is keyed by `BriefMethod` (`"agents.catchup"`, `"agents.decisions"`).
- **Refinement:** In `checkCatalogParams`, look up each agent by both short name and prefixed name:
  ```ts
  const entry = catalog[agent] ?? catalog[`agents.${agent}`];
  ```
  This makes `checkCatalogParams` resilient whether it is passed `AGENT_CATALOG` directly or an object transformed by short names.

---

### 3.2 Singular vs. Plural Wording in `describeAgentVisibility` (Task 2)

In Task 2:
> *"Its first line is either `agent visibility: all agents (no active pack sets [agents] visible)` or `agent visibility: the agents listed by packs <id>, <id>`."*

When exactly **one** pack sets `visible`:
- Should it output `the agents listed by packs ops` or `the agents listed by pack ops`?
- **Refinement:** The plan states `the agents listed by packs <id>, <id>`. Using `packs ${v.packs.join(", ")}` uniformly keeps the parser deterministic and avoids singular/plural branch branching in both the emitter and its assertions.

---

### 3.3 Safe Handling of Extensions with Empty or Missing Names (Task 4)

In Task 4:
> *"An extension's `name` is the verified manifest's `name`, cut to 200 characters, and `null` when absent or when `readVerifiedManifest` throws."*

In `packages/registry-format/src/manifest.ts`, `ExtensionManifest.name` is optional (`name?: string`).
- Authors might supply `name: ""` (an empty string) or whitespace.
- **Refinement:** Normalize empty strings to `null`:
  ```ts
  const rawName = manifest.name?.trim();
  const name = rawName && rawName.length > 0 ? rawName.slice(0, 200) : null;
  ```
- In Task 6, an extension with `name: null` renders as `(no name)`.

---

### 3.4 CLI JSON Filtering Contract (Task 6)

In Task 6:
> *"`--json` prints the raw `CatalogListResult`, filtered to the half that was asked for."*

**Refinement:**
- `nimbus catalog --json` $\to$ returns full `CatalogListResult` (`{ agents, connectors, visibility }`).
- `nimbus catalog agents --json` $\to$ returns `{ agents, visibility }`.
- `nimbus catalog connectors --json` $\to$ returns `{ connectors }`.
Returning valid JSON containing the respective keys matches the command options cleanly.

---

### 3.5 Sorting Determinism Across All Catalog Tables (Task 3 & Task 4)

In Task 3 and Task 4:
- Agents are sorted with `codeUnitCompare` (`util/code-unit-compare.ts`).
- Built-in connectors, extensions, and user MCP servers are each sorted by ID.
- **Refinement:** Use `codeUnitCompare` for connector IDs as well, rather than standard `Array.prototype.sort()`:
  ```ts
  const builtinConnectors = Object.keys(CONNECTOR_CATALOG_META)
    .sort(codeUnitCompare)
    .map((id) => ({ kind: "builtin" as const, id, ...CONNECTOR_CATALOG_META[id] }));
  ```
  This guarantees 100% deterministic, locale-invariant ordering across Linux, macOS, and Windows.

---

## 4. Test Strategy & Verification Gaps

### 4.1 Red-Proof Verification Protocol for Task 5 Guard

Task 5 requires a negative verification test:
> *"It must be red-proven: add a temporary `resolveAgentVisibility` reference to `ipc/agents-rpc.ts`, see the test fail, then revert."*

To ensure this gate is bulletproof during execution:
1. Write `visibility-is-presentation-only.test.ts` first.
2. Verify that temporarily adding `// test: resolveAgentVisibility` in `ipc/agents-rpc.ts` triggers an immediate failure.
3. Remove the line and confirm green.

### 4.2 Subprocess Clean-up in E2E Testing (`catalog-list.e2e.test.ts`)

In Task 6, `catalog-list.e2e.test.ts` boots a real gateway via `startRealGateway` in `packages/gateway/test/e2e/_fixtures/real-gateway-client.ts`.
- Ensure `try ... finally { await gw.stop(); }` surrounds client operations.
- On Windows, named pipe handles can linger if not explicitly closed before `proc.kill()`, which `TinyIpcClient` handles properly provided `client.disconnect()` is called.

---

## Summary Checklist for Implementer

- [ ] Task 1: `parseAgentNameList` handles spaces inside brackets, rejects unquoted strings, and strictly rejects trailing commas.
- [ ] Task 2: `resolveAgentVisibility` safely handles `section === undefined` and uses `findLast` to extract `shadowed` once.
- [ ] Task 2: Catch `TypeError` from `parseStringArray` on malformed user `show`/`hide`.
- [ ] Task 3: In `CatalogParam`, specify `armOptional?: boolean` for `why.line` while keeping `param.required: false`.
- [ ] Task 3: Support both short name and `BriefMethod` keys in `checkCatalogParams`.
- [ ] Task 4: Use `codeUnitCompare` for all sorting across agents and connectors.
- [ ] Task 5: Check `ctx.options.configDir !== undefined` in `tryDispatchCatalogRpc`.
- [ ] Task 5: Unquote `path` in `explainConfig` before checking for `agents` prefix.
- [ ] Task 6: Add `"catalog"` to `COMMAND_NAMES` in [packages/cli/src/commands/registry.ts](file:///C:/gitrep/Nimbus/packages/cli/src/commands/registry.ts) and export `runCatalog` from [packages/cli/src/commands/index.ts](file:///C:/gitrep/Nimbus/packages/cli/src/commands/index.ts).

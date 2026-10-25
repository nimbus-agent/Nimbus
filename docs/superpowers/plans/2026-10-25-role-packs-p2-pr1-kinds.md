# Role packs P2 PR 1 — source kinds, no behaviour change — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The decisions and glossary passes, and the three service-keyed decision helpers, resolve sources through ONE `service:type` → kind table, with every output identical to today.

**Architecture:** A new `packages/gateway/src/sources/source-kinds.ts` holds the built-in table and the per-pass kind sets. `decision-source-types.ts` and `glossary-source-types.ts` keep their exports (other files and the I28 test import them) but derive them from the table. `sourceAuthority`, the ADR lookup and ticket-key matching read the kind. No config key, no schema change — those are PR 2.

**Tech Stack:** Bun + TypeScript strict, `bun:sqlite`, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md` § 3 and § 9 item 1 (+ `-review.md` disposition). Both on `dev/asaf/role-packs` only.

## Global Constraints

- Work on a new branch `dev/asaf/role-packs-p2-kinds` from `origin/main`, in a worktree created with an ABSOLUTE path: `git worktree add C:/gitrep/Nimbus/.claude/worktrees/role-packs-p2-kinds -b dev/asaf/role-packs-p2-kinds origin/main`. Never commit on `main`. No `docs/superpowers/**` file on this branch.
- Five kinds, exactly: `message`, `doc`, `ticket`, `commit`, `note`.
- Pass kind sets, exactly: decisions = `message, doc, ticket, note`; glossary = `message, doc, ticket, commit, note`.
- Built-in table, exactly (spec § 3): message `slack:message`, `discord:message`, `teams:message`; doc `notion:page`, `confluence:page`, `obsidian:obsidian_note`; ticket `linear:issue`, `jira:issue`, `github:issue`, `gitlab:issue`; commit `github:commit`, `gitlab:commit`, `filesystem:git_commit`. No `note` entries, no email/calendar, no `nimbus:*`.
- Behaviour is byte-for-byte unchanged: every existing test under `packages/gateway/src/{decisions,glossary,agents,mcp-sink}` passes **unmodified**. A task that needs to edit an existing assertion has found a behaviour change — stop and report it, don't edit the test.
- The service-qualified filter rule stands: never filter on the bare `type` half.
- No `any`; SQL params bound (I9); dynamic `IN` lists built as one `?` per key.
- Run `bun run typecheck:tests` as well as `bun run typecheck` — it is the only check that sees `packages/gateway/test/**`.
- Before opening the PR, run the WHOLE gateway src suite (`bun test packages/gateway/src`), not only touched folders: guard tests elsewhere (e.g. `security-invariants.test.ts`, `catalog/visibility-is-presentation-only.test.ts`) only fail on a whole run.
- PR title (squash commit, release-please reads it): `refactor(decisions): resolve decision and glossary sources through one kind table`. No `!`.

## Plan ruling (deviation from the spec, recorded for the reviewer)

Spec § 3 calls the authority change for unmapped types "unobservable". It is not: owner-accepted agent decisions (`mcp-sink/capture-native.ts:150`) can point at ANY item type, and `agents/decisions.ts:57` (explain) and `:265` (stale-score recompute) score them through `sourceAuthority(serviceType)`. A `bitbucket:issue` source scores 0.6 today via the `*:issue` suffix rule. Ruling: `sourceAuthority` scores by kind when the type is in the table and falls back to today's rule (`*:issue` → 0.6, else 0.3) when it is not. Cost if wrong: one fallback branch to delete later; without it, stored scores of such rows would read as "previous scale".

## Review Focus

1. An owner-accepted agent decision whose source is outside the table (`bitbucket:issue`, `gmail:email`) — authority must stay 0.6 / 0.3 (Task 2 test `unmapped types keep today's authority`).
2. A `github:issue` / `gitlab:issue` source, now ticket-kind — must still never ticket-key-match, since neither writes `key`/`identifier` (Task 2 test `github issue metadata never ticket-key-matches`).
3. A same-named type from another service (`google_drive:page`, `wiz:issue`) — must be admitted by no filter, the ADR lookup included (Task 1 and Task 2 tests).
4. Parameter order of the derived filters — existing tests and callers may depend on the literal order; the table keeps the literal order (Task 1 test compares as ordered arrays).
5. A Jira/Linear ticket whose key prefix matches the service — must still match after the query change (Task 2 test `jira key still matches`).

---

### Task 1: The kind table, and both source-type modules derived from it

**Files:**
- Create: `packages/gateway/src/sources/source-kinds.ts`
- Create: `packages/gateway/src/sources/source-kinds.test.ts`
- Modify: `packages/gateway/src/decisions/decision-source-types.ts` (the `DECISION_SOURCE_TYPES` literal at `:13`)
- Modify: `packages/gateway/src/glossary/glossary-source-types.ts` (the `GLOSSARY_SOURCE_TYPES` literal at `:23`)
- Modify: `scripts/coverage-floor/exclusions.ts` (`NEVER_EXEMPT_PATHS`, beside the two source-type files at `:363-364`)

**Interfaces:**
- Produces (`sources/source-kinds.ts`):
  - `export type SourceKind = "message" | "doc" | "ticket" | "commit" | "note";`
  - `export const SOURCE_KINDS: readonly SourceKind[]` — the five, in that order.
  - `export const BUILTIN_SOURCE_KINDS: ReadonlyMap<string, SourceKind>` — keys `service:type`, insertion order exactly the Global Constraints list (message, doc, ticket, commit groups in that order, entries in the listed order).
  - `export type SourcePass = "decisions" | "glossary";`
  - `export const PASS_KINDS: Readonly<Record<SourcePass, ReadonlySet<SourceKind>>>`
  - `export function sourceKindOf(serviceType: string): SourceKind | undefined` — built-in lookup.
  - `export function sourceTypesFor(pass: SourcePass): readonly string[]` — table keys whose kind is in `PASS_KINDS[pass]`, table order.
  - `export function sourceTypesOfKind(kind: SourceKind): readonly string[]` — table order.
- `DECISION_SOURCE_TYPES` / `GLOSSARY_SOURCE_TYPES` keep name and type (`ReadonlySet<string>`), now `new Set(sourceTypesFor(...))`. `decisionSourceFilter()` / `glossarySourceFilter()` unchanged in signature and output.

- [ ] **Step 1: Write `source-kinds.test.ts`**

```ts
// The literals below are copied verbatim from origin/main decision-source-types.ts:13 and
// glossary-source-types.ts:23 before this change. They are the behaviour contract: do not edit
// them to make a failing test pass.
const DECISIONS_BEFORE = ["slack:message","discord:message","teams:message","notion:page","confluence:page","obsidian:obsidian_note","linear:issue","jira:issue","github:issue","gitlab:issue"];
const GLOSSARY_BEFORE = [...DECISIONS_BEFORE, "github:commit","gitlab:commit","filesystem:git_commit"];

test("the decisions set is exactly today's list, in today's order", () => {
  expect([...sourceTypesFor("decisions")]).toEqual(DECISIONS_BEFORE);
  expect([...DECISION_SOURCE_TYPES]).toEqual(DECISIONS_BEFORE);
});
test("the glossary set is exactly today's list, in today's order", () => {
  expect([...sourceTypesFor("glossary")]).toEqual(GLOSSARY_BEFORE);
  expect([...GLOSSARY_SOURCE_TYPES]).toEqual(GLOSSARY_BEFORE);
});
test("the filters' params are unchanged", () => {
  expect(decisionSourceFilter().params).toEqual(DECISIONS_BEFORE);
  expect(glossarySourceFilter().params).toEqual(GLOSSARY_BEFORE);
});
test("doc kind is the three long-form sources", () => {
  expect([...sourceTypesOfKind("doc")]).toEqual(["notion:page","confluence:page","obsidian:obsidian_note"]);
});
test("the built-in table has no note, email, calendar or nimbus entries", () => {
  for (const [key, kind] of BUILTIN_SOURCE_KINDS) {
    expect(kind).not.toBe("note");
    expect(key.startsWith("nimbus:")).toBe(false);
    expect(/:(email|calendar_event|event)$/.test(key)).toBe(false);
  }
});
test("lookup is service-qualified", () => {
  expect(sourceKindOf("jira:issue")).toBe("ticket");
  expect(sourceKindOf("wiz:issue")).toBeUndefined();
  expect(sourceKindOf("issue")).toBeUndefined();
});
test("PASS_KINDS is the spec's two rows", () => {
  expect([...PASS_KINDS.decisions].sort()).toEqual(["doc","message","note","ticket"]);
  expect([...PASS_KINDS.glossary].sort()).toEqual(["commit","doc","message","note","ticket"]);
});
```

- [ ] **Step 2: Run it** — `bun test packages/gateway/src/sources/source-kinds.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `sources/source-kinds.ts`** with the Interfaces above. Header comment: the table is the one place a source is classified; the service-qualified rule (moved from the two source-type files' comments, keep their reasoning about `wiz:issue` and `service_spread`); email/calendar absence (the existing posture); `nimbus:*` never a source (I28). Then replace the two literals with `new Set(sourceTypesFor("decisions"))` / `new Set(sourceTypesFor("glossary"))`, keeping each file's header comment but pointing it at the table. Keep `glossary-source-types.ts`'s commit-source explanation (it is still true and explains why dead `github:commit` rows are harmless).

- [ ] **Step 4: Add `"packages/gateway/src/sources/source-kinds.ts"`** to `NEVER_EXEMPT_PATHS` beside the two source-type files, with a one-line comment (classifies every decisions/glossary source; untested edits reach the query layer).

- [ ] **Step 5: Verify** — `bun test packages/gateway/src/sources packages/gateway/src/decisions packages/gateway/src/glossary packages/gateway/src/security-invariants.test.ts` → all pass, no existing test edited. `bun run typecheck` → clean.

- [ ] **Step 6: Commit** — `git add packages/gateway/src/sources packages/gateway/src/decisions/decision-source-types.ts packages/gateway/src/glossary/glossary-source-types.ts scripts/coverage-floor/exclusions.ts && git commit -m "refactor(sources): one service:type to kind table behind both source sets"`

---

### Task 2: Authority, ADR lookup and ticket matching read the kind

**Files:**
- Modify: `packages/gateway/src/decisions/decision-confidence.ts` (`sourceAuthority`, `:15-25`)
- Modify: `packages/gateway/src/decisions/decision-corroborate.ts` (the ADR query, `:183-193`)
- Modify: `packages/gateway/src/decisions/decision-service-scope.ts` (`ticketIdentifier` doc comment `:93-101`, `matchesTicketKey` `:105-126`)
- Test: `packages/gateway/src/decisions/decision-confidence.test.ts`, `decision-corroborate.test.ts`, `decision-service-scope.test.ts` (ADD tests only)

**Interfaces:**
- Consumes (Task 1): `sourceKindOf`, `sourceTypesOfKind`, `SourceKind`.
- Produces: no new exports. `sourceAuthority(serviceType: string): number` keeps its signature.

- [ ] **Step 1: Write the failing/pinning tests (add to the existing files; reuse each file's existing DB/fixture helpers)**

`decision-confidence.test.ts`:
```ts
test("authority by kind: doc 1, ticket 0.6, message and commit 0.3", () => {
  expect(sourceAuthority("notion:page")).toBe(1);
  expect(sourceAuthority("obsidian:obsidian_note")).toBe(1);
  expect(sourceAuthority("jira:issue")).toBe(0.6);
  expect(sourceAuthority("github:issue")).toBe(0.6);
  expect(sourceAuthority("slack:message")).toBe(0.3);
  expect(sourceAuthority("filesystem:git_commit")).toBe(0.3);
});
test("unmapped types keep today's authority (agent decisions can point anywhere)", () => {
  expect(sourceAuthority("bitbucket:issue")).toBe(0.6);
  expect(sourceAuthority("wiz:issue")).toBe(0.6);
  expect(sourceAuthority("gmail:email")).toBe(0.3);
  expect(sourceAuthority("google_drive:file")).toBe(0.3);
});
```
`decision-corroborate.test.ts`: `ADR lookup admits doc-kind sources only` — seed an ADR-titled item (`"ADR-12: use Postgres"`, a statement overlapping its tokens) as `google_drive:page` and as `wiz:issue` → no `adr` evidence; the same as `confluence:page` → one `adr` evidence row with that item's id.
`decision-service-scope.test.ts`:
- `jira key still matches` — a `jira:issue` with `metadata {"key":"BILLING-123"}` → `matchesService(..., service: "billing")` is `"ticket-key"`.
- `linear identifier still matches` — `linear:issue`, `{"identifier":"BILLING-7"}` → `"ticket-key"`.
- `github issue metadata never ticket-key-matches` — `github:issue` with the GitHub writer's shape `{"number":12,"repo":"acme/billing","state":"open","user":"x"}` and no repo evidence → `null`.
- `a key on a non-ticket type does not match` — `slack:message` with `{"key":"BILLING-1"}` → `null`.

- [ ] **Step 2: Run** — `bun test packages/gateway/src/decisions` → every new test PASSES on today's code. This task preserves behaviour, so the new tests are pins, not red tests. Red-prove each pin by temporarily breaking its target line (e.g. make `sourceAuthority` return 0.3 for `bitbucket:issue`; drop `confluence:page` from the ADR list; drop the `identifier` branch), watching that test fail, then restoring. Run the pins again after Step 3, which must keep them green. List each red-proof in the report.

- [ ] **Step 3: Implement**
  - `sourceAuthority`: `const kind = sourceKindOf(serviceType);` doc → 1, ticket → 0.6, message/commit/note → 0.3; `kind === undefined` → today's rule (`endsWith(":issue")` → 0.6, else 0.3), with a comment citing agent decisions as the reason. Use an exhaustive `switch` over `SourceKind` so a sixth kind is a compile error.
  - ADR query: replace the literal `IN (...)` with placeholders built from `sourceTypesOfKind("doc")`, params bound; keep the title-shape predicates, `ORDER BY modified_at DESC, id ASC`, `LIMIT 200` exactly.
  - `matchesTicketKey`: select `service, type, metadata`; replace `row.service !== "jira" && row.service !== "linear"` with `sourceKindOf(`${row.service}:${row.type}`) !== "ticket"`. Rewrite the `ticketIdentifier` doc comment: any ticket-kind item matches only through `metadata.key` or `metadata.identifier`; Jira writes the first, Linear the second; GitHub/GitLab issues write neither (`connectors/github-sync.ts:411-416`), so they never match — a stated bound, not an accident.

- [ ] **Step 4: Verify** — `bun test packages/gateway/src/decisions packages/gateway/src/agents packages/gateway/src/glossary packages/gateway/src/mcp-sink` → all pass, no existing assertion edited; `confidence-ceiling.test.ts` still reads 1.0. `bun run typecheck` and `bun run typecheck:tests` → clean / 0 new.

- [ ] **Step 5: Commit** — `git commit -m "refactor(decisions): authority, ADR lookup and ticket keys read the source kind"`

---

### Task 3: Docs, whole-suite verification, PR

**Files:**
- Modify: `.claude/commands/nimbus-implicit-knowledge-extraction.md` (where it names the `<service>:<type>` source-type SSoTs: point at `packages/gateway/src/sources/source-kinds.ts` as the classification, the two modules as derived)
- Modify: `docs/architecture.md` (the decisions/glossary subsystem section: one short paragraph — sources are classified by kind in `sources/source-kinds.ts`; each pass reads a kind set; authority/ADR/ticket matching key on kind; unmapped types keep the legacy authority rule)
- Modify: `docs/CHANGELOG.md` (one line under the unreleased/today heading, following the file's existing format: internal refactor, no behaviour change, groundwork for role-pack source mappings)

- [ ] **Step 1: Edit the three docs** as above. Grep the repo for other prose naming `DECISION_SOURCE_TYPES` / `GLOSSARY_SOURCE_TYPES` as the place sources are defined (`git grep -n "SOURCE_TYPES" -- docs .claude GEMINI.md CLAUDE.md`) and correct each restatement.

- [ ] **Step 2: Verify**
  - `bun run preflight:fast` → `preflight PASSED`.
  - `bun run typecheck:tests` → `0 new`.
  - `bun test packages/gateway/src` → 0 fail.
  - `git diff origin/main --stat -- docs/superpowers` → empty.

- [ ] **Step 3: Commit and open the PR** — commit the docs (`docs: source kinds`), push, `gh pr create` with the Global Constraints title. Body: what moved, the plan ruling on unmapped authority, the statement that no existing test was edited, and the attribution line. Then check CodeRabbit threads after each push.

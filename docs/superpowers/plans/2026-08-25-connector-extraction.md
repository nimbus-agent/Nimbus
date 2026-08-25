# Connector Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `packages/mcp-connectors/**` out of the monorepo into `nimbus-agent/nimbus-mcp-servers`, publish it as `@nimbus-dev/connectors`, and have the gateway consume it from npm — without the compiled binary losing the ability to start a connector.

**Architecture:** The gateway's *only* runtime coupling to the connector tree is one generated file, `packages/gateway/src/connectors/bundled-connector-registry.ts`, which maps each id to a dynamic `import()`. The extraction changes those specifiers from relative paths to `@nimbus-dev/connectors/<id>` and changes nothing else about how a connector is spawned. `bun build --compile` embeds bare-specifier dynamic imports, so the compiled binary keeps working — and `test:connector-boot` is the gate that proves it rather than the assumption that carries it.

**Tech Stack:** Bun 1.2+, TypeScript 7 strict, Biome, npm (`@nimbus-dev` scope), GitHub Actions.

**Spec:** [`docs/superpowers/specs/2026-08-24-connector-extraction-design.md`](../specs/2026-08-24-connector-extraction-design.md) — §2a (destination), §4a (why thin), §7 (gates), §8 (release choreography).

**Scope:** This is **Plan 2 of 2**. Plan 1 — the `SyncContext` narrowing — shipped in #1333 and is a prerequisite, not part of this. The boundary is **thin**: only `packages/mcp-connectors/**` moves. Nothing under `packages/gateway/src/` relocates, which is what keeps `SyncContext` an internal interface rather than a published contract.

## Global Constraints

- **Destination is `nimbus-agent/nimbus-mcp-servers`** — it exists, empty, created 2026-06-18 for exactly this. Do not create a new repo.
- **Package is `@nimbus-dev/connectors`; bin is `nimbus-connector`.** Both verified free on npm 2026-08-24. `nimbus-mcp` belongs to an unrelated third party and must never be used — see #1323.
- **ONE package, not 94.** The scaffold's README proposes `npx @nimbus/mcp-github`; §2a records why that is overridden.
- **Delete the monorepo copy LAST**, only after `test:connector-boot` is green against the *published* artifact. A deletion that precedes the proof is unrecoverable in the same PR.
- **The gateway must not import connector source directly** — that rule predates this plan (`connectors/_lib/apple-caldav-fetch.ts:11`). The generated registry is the only route, and it stays the only route.
- No `any`. TypeScript strict. Every task ends with `bun run preflight:fast` plus the named checks.
- **Verify with the CI command, not a scoped one:** `bun test packages/gateway packages/cli packages/mcp-connectors scripts`. A `src`-only run cost four red rounds on #1333.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `scripts/gen-bundled-connector-registry.ts` | emits the id → `import()` map; the entire runtime coupling | 1, 5 |
| `packages/mcp-connectors/package.json` **(new)** | the publishable `@nimbus-dev/connectors` manifest + `exports` map | 2 |
| `scripts/connector-boot-smoke.ts` | `test:connector-boot` — proves the compiled binary starts a connector | 1, 6 |
| `nimbus-mcp-servers` repo | destination; its README is stale and misleading | 3, 4 |
| `packages/gateway/package.json` | gains the `@nimbus-dev/connectors` dependency | 6 |
| `scripts/audit/connector-version-skew.ts` **(new)** | fails when the gateway's pin lags the registry | 7 |
| the 92 path references + 5 gates | rewritten or retargeted | 5, 8 |

---

### Task 1: Prove the seam BEFORE anything moves

The whole plan rests on one unproven claim: that a compiled binary can start a connector imported by **bare specifier** from a published package, rather than by relative path. Prove it against a locally-packed tarball, in the monorepo, with nothing moved and nothing published. If this fails, the design is wrong and no files should move.

**Files:**

- Modify: `scripts/gen-bundled-connector-registry.ts`
- Test: `scripts/connector-boot-smoke.ts` (existing gate, run unchanged)

**Interfaces:**

- Produces: evidence, in the form of a green `test:connector-boot` against a tarball-installed package. Nothing else in this task is kept.

- [ ] **Step 1: Record the baseline so the comparison is real**

```bash
bun run gen:connector-registry
bun run build            # produces dist/nimbus-gateway
bun run test:connector-boot
```

Expected: PASS, with the CURRENT relative-path registry. Write the number of connectors it booted into the task notes — a later "PASS" that boots fewer is not a pass.

- [ ] **Step 2: Pack the connector tree as it stands**

```bash
cd packages/mcp-connectors
bun pm pack --destination /tmp        # or `npm pack` if bun's differs
```

There is no `package.json` at that path yet, so this fails. That failure is the point: it tells you Task 2 is a prerequisite of the proof, not of the move. **Do Task 2 Step 1–3 now, then return here.**

- [ ] **Step 3: Install the tarball into a scratch consumer and re-point the generator**

Teach the generator to emit bare specifiers behind a flag, so the change is reversible and reviewable:

```ts
const SPECIFIER =
  process.env["NIMBUS_CONNECTOR_SPECIFIER"] === "package"
    ? (id: string) => `@nimbus-dev/connectors/${id}`
    : (id: string) => `../../../mcp-connectors/${id}/src/server.ts`;
```

- [ ] **Step 4: Rebuild and run the gate against the packaged form**

```bash
NIMBUS_CONNECTOR_SPECIFIER=package bun run gen:connector-registry
bun run build
bun run test:connector-boot
```

Expected: PASS, booting the SAME number of connectors as Step 1.

**If it fails, stop and report.** The likely causes, in order: `bun build --compile` not embedding a bare-specifier dynamic import (the assumption under test); the `exports` map not resolving subpaths; or a connector reaching a file the package does not ship. Each is a design problem, not a packaging detail.

- [ ] **Step 5: Revert the generator to relative paths and commit only the flag**

The flag stays; the default does not change until Task 6.

```bash
git add scripts/gen-bundled-connector-registry.ts packages/mcp-connectors/package.json
git commit -m "feat(build): connector registry can emit package specifiers, proven by connector-boot"
```

---

### Task 2: Make `packages/mcp-connectors` a publishable package

**Files:**

- Create: `packages/mcp-connectors/package.json`
- Modify: `packages/mcp-connectors/README.md` (or create)

**Interfaces:**

- Produces: `@nimbus-dev/connectors` with a subpath `exports` map, consumed as `@nimbus-dev/connectors/<id>` by the generated registry.

- [ ] **Step 1: Write the manifest**

```jsonc
{
  "name": "@nimbus-dev/connectors",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "type": "module",
  "bin": { "nimbus-connector": "./standalone/src/bin.ts" },
  "files": ["*/src/**", "*/nimbus.extension.json", "shared/**", "standalone/**", "NOTICE"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.30.0",
    "@nimbus-dev/sdk": "^1.20.0"
  }
}
```

`private: true` until Task 4 publishes deliberately — the 94 connector packages were left publishable for months and #1323 had to disarm them.

- [ ] **Step 2: Generate the exports map rather than hand-writing 94 entries**

A hand-maintained map of 94 subpaths is a drift source with no gate. Emit it from the same directory scan the registry generator already uses:

```ts
// scripts/gen-connector-exports.ts
const exportsMap = Object.fromEntries(
  bundledConnectorIds().map((id) => [`./${id}`, `./${id}/src/server.ts`]),
);
```

- [ ] **Step 3: Verify the package resolves before trusting it**

```bash
bun run gen:connector-exports
bun -e 'import("@nimbus-dev/connectors/github").then(() => console.log("resolves"))'
```

Expected: `resolves`. Then return to Task 1 Step 2.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-connectors/package.json scripts/gen-connector-exports.ts
git commit -m "feat(connectors): publishable package manifest with a generated exports map"
```

---

### Task 3: Populate the destination repo

**Files:** the `nimbus-mcp-servers` repo (exists, empty apart from `.gitignore`, `LICENSE`, `README.md`, `NEW-SESSION-PROMPT.md`).

- [ ] **Step 1: Preserve history for the moved tree**

A plain copy discards 209 test files' worth of blame. Use a subtree split so the connector history survives:

```bash
git subtree split --prefix=packages/mcp-connectors -b connectors-split
```

- [ ] **Step 2: Push into the destination**

```bash
git remote add mcp-servers git@github.com:nimbus-agent/nimbus-mcp-servers.git
git push mcp-servers connectors-split:main --force-with-lease
```

`--force-with-lease` rather than `--force`: the repo has four files on `main` and clobbering someone else's push is not a risk worth taking for convenience.

- [ ] **Step 3: Restore the four scaffold files the split overwrote**

`LICENSE` (AGPL, 34KB) must survive — it is the licence the published package claims. `NEW-SESSION-PROMPT.md` can go; it is a build prompt for work now done.

- [ ] **Step 4: Rewrite the README, which is actively misleading**

It says *"Status: SCAFFOLD — not yet built"* and lists three decisions "to make first" that Project B already answered and shipped:

| Its open question | Answer, and where it shipped |
| --- | --- |
| Share vs vendor vs fork | Extraction, one package — this plan |
| Credential model outside the Vault | Env vars + consent kit — #1318 |
| AGPL implications downstream | `NOTICE` security tiering — #1318 |
| "Candidate first connectors: github, linear" | All 94 are standalone-eligible — #1321 |

Also correct `npx @nimbus/mcp-github` to `npx @nimbus-dev/connectors <id>`, and carry over the client-support matrix from `standalone/README.md` — **Claude Desktop has no elicitation, so writes do not appear there**, which is the first thing a user of this repo will hit.

- [ ] **Step 5: CI in the new repo**

Port the connector-relevant gates only: `bun test`, `lint`, `typecheck`, and `audit:connector-consent` (which #1321 wired into CI after it ran nowhere at all). The coverage floor and the 3-OS matrix are gateway concerns and do not follow.

---

### Task 4: Publish `0.1.0`

- [ ] **Step 1: Flip `private` and set the version**

- [ ] **Step 2: Dry-run first and read the file list**

```bash
npm publish --dry-run --access public
```

Check for two specific failures: `shared/**` present (166+ files import it by relative path — if it is missing every connector breaks at runtime, not at install), and no `*.test.ts` shipped.

- [ ] **Step 3: Publish, then verify from outside**

```bash
npm publish --access public
cd $(mktemp -d) && npm init -y >/dev/null && npm i @nimbus-dev/connectors
bun -e 'import("@nimbus-dev/connectors/github").then(() => console.log("ok"))'
```

Installing into a scratch directory is the only check that catches a `files` field that works locally because the source tree is there anyway.

---

### Task 5: Retarget the monorepo's references and gates

**Files:** `scripts/gen-bundled-connector-registry.ts`, the five path-resolving gates, ~92 files referencing the path.

- [ ] **Step 1: Derive the reference list mechanically**

The spec's §7 warns that "84 references" is not a checklist — a recount gave 92. Derive it:

```bash
grep -rl 'packages/mcp-connectors\|mcp-connectors/' --include=*.ts --include=*.json --include=*.md --include=*.yml . \
  | grep -v node_modules | grep -v '^./packages/mcp-connectors/' | sort > /tmp/refs.txt
wc -l /tmp/refs.txt
```

- [ ] **Step 2: Classify before editing**

Three kinds, and only one is mechanical: **docs** (rewrite to point at the new repo), **gates** (retarget or retire), **`biome.json` / `knip.json` / `.github/labeler.yml`** (drop the path). Anything that does not fit those three is a finding — report it rather than guessing.

- [ ] **Step 3: The five gates, one at a time**

`gen:connector-registry` and `test:connector-boot` retarget to the package. `audit:connector-entrypoints`, `audit:connector-deps` and `audit:connector-registry-drift` move to the new repo — but `audit:connector-deps` must check the gateway's **resolved dependency tree**, not source manifests, because a native transitive dependency silently breaks the compiled binary and a source-manifest check cannot see it.

- [ ] **Step 4: The cross-platform parity test**

`scripts/ci/cross-platform-parity.test.ts` asserts `packages/mcp-connectors` appears in the `bun test` path list of **both** `ci.yml` and `_test-suite.yml`. Both lists lose the path together, and the assertion is rewritten rather than deleted — that equality is load-bearing and only became true on 2026-08-23.

---

### Task 6: Consume the published package

- [ ] **Step 1: Add the dependency and flip the generator default**

- [ ] **Step 2: The proof gate, against the PUBLISHED artifact**

```bash
bun install && bun run gen:connector-registry && bun run build && bun run test:connector-boot
```

Expected: PASS, booting the same count as Task 1 Step 1. This is the gate the whole plan exists to satisfy; Task 1 proved it against a tarball, this proves it against what users install.

- [ ] **Step 3: Full CI-parity verification**

```bash
bun test packages/gateway packages/cli scripts    # mcp-connectors is gone from this list
bun run preflight
```

---

### Task 7: The version-skew gate, before the deletion

Spec §8 requires this and calls it required, not optional — `@nimbus-dev/sdk` is pinned at four different floors inside this one repo today.

- [ ] **Step 1: Write it**

Compare the `@nimbus-dev/connectors` version pinned in `packages/gateway/package.json` against the registry's latest. Fail on a **major or minor** gap; warn on patch. A minor gap means the gateway is missing a connector capability that already shipped.

- [ ] **Step 2: Wire it into BOTH the manifest and a workflow, in one commit**

`scripts/lib/preflight-gates.ts` **and** `.github/workflows/_test-suite.yml`. #1318 added `audit:connector-consent` to the manifest and to no workflow, so it ran nowhere and the PR passed *because the gate never executed*. `preflight-gates.test.ts` guards that class now; satisfy it.

---

### Task 8: Delete the monorepo copy — last

- [ ] **Step 1: Confirm the preconditions, explicitly**

Do not proceed unless all four hold: Task 6 Step 2 green against the published package; the new repo's CI green; `audit:connector-version-skew` live; and the published tarball verified from a scratch install (Task 4 Step 3).

- [ ] **Step 2: Delete, and update the workspace**

```bash
git rm -r packages/mcp-connectors
```

Remove it from the root `package.json` workspaces, then `bun install` and **commit the lockfile** — a workspace removal changes it, and CI installs `--frozen-lockfile`.

- [ ] **Step 3: Verify the deletion did not take something with it**

```bash
bun run preflight
bun test packages/gateway packages/cli scripts
bun run build && bun run test:connector-boot
```

- [ ] **Step 4: Update CLAUDE.md and GEMINI.md**

Both list `packages/mcp-connectors/*` under Subsystems and must gain `nimbus-mcp-servers` in the satellite-repo list. They mirror each other; edit both or the drift gate fires.

## Self-Review

**Spec coverage.** §2a destination → Task 3. §4a thin boundary → the scope note and Task 5's classification. §7 gates → Tasks 5 and 7. §8 release choreography → Tasks 4, 6, 7. §9 sequencing → Tasks 1 (prove), 3–5 (move), 6 (consume), 8 (delete last).

**Placeholders.** None. Task 2 Step 1 carries the actual manifest; Task 1 Step 3 the actual generator change. The two tasks that cannot be fully scripted — the 92 references and the five gates — carry the derivation command and a classification rule instead of a fabricated list, because the spec explicitly warns that a stale count is not a checklist.

**Type consistency.** `@nimbus-dev/connectors` and the `nimbus-connector` bin are named identically throughout. `bundledConnectorIds()` is reused by the exports generator rather than a second directory scan, so the two cannot disagree about which directories are connectors.

**The ordering that matters, and why.** Task 1 proves the riskiest assumption — bare-specifier dynamic imports surviving `--compile` — **before** any file moves, any repo is populated, or anything is published. Task 8 deletes only after the published artifact has booted a connector from a compiled binary. Everything between is reversible; those two are not, which is why they bracket the plan.

**Known weakness.** Task 3's subtree split preserves history for the moved tree but leaves the monorepo's own history containing the connectors forever. That is correct — rewriting monorepo history is far more dangerous than a duplicated ancestry — but it means `git log --follow` across the boundary will not work, and anyone bisecting a connector bug older than the split needs the monorepo.

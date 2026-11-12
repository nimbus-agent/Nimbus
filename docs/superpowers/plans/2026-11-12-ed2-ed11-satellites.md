# ED2 to ED11 — Satellite repositories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the 2026-11-12 direction into the nine satellite repositories' own documents, correct the facts that drifted there, and retire the five scaffold repositories.

**Architecture:** One small documentation pull request per repository, each made in a fresh clone under the session scratchpad so no existing checkout is disturbed. Every fact is derived from its source of truth at the moment of writing. The five archive calls run last, after the owner confirms.

**Tech Stack:** Markdown; `gh`; each repository's own CI.

**Spec:** `docs/superpowers/specs/2026-11-12-ecosystem-direction.md` in the `Nimbus` repository (sections cited as § n). Slices ED2 to ED11 of § 5.13. ED1 has its own plan and merges first.

## Global Constraints

- ED1 is merged before any slice here opens its pull request, because these documents link to `Nimbus/docs/roadmap.md` § Direction and to Phases 28 to 30.
- Nothing here changes what Nimbus publicly claims to be: no tagline, repository description, topic or store listing is edited (D-ECO-1). `ECOSYSTEM.md` and the profile README keep their opening description.
- No count, version or invariant range is copied from the spec or this plan. Each is derived when written: connector count from `Nimbus/packages/gateway/src/connectors/bundled-connector-registry.ts`; invariant range and schema version from `Nimbus/CLAUDE.md`; released versions from `gh release list`.
- Documents call the five scaffolds **retired**. Only the note inside each scaffold repository says it is archived.
- Roadmap rows added here are unticked. Nothing unbuilt is described as shipped.
- Pull request titles use the type `docs` (no release is cut by a `docs` commit), with no `!`.
- Each clone lives at `<scratchpad>/sat/<repo>`; branch name `docs/ecosystem-direction`.

## Review Focus

1. **A satellite document links to an anchor ED1 did not create.** Expected: every link to `Nimbus/docs/roadmap.md#…` resolves on `main` after ED1. Pinned in each task's verify step.
2. **A count is stale on the day it merges.** Expected: the count in the pull request equals the count the source file gives at that commit. Pinned in Task 1 Step 1.
3. **An archive call hits a repository whose note has not merged.** Expected: archive only after that repository's README pull request is merged. Pinned in Task 10 Step 3.
4. **A live document still presents a scaffold as a live project.** Expected: the organisation-wide search of Task 10 Step 5 finds only "retired" notes.
5. **A satellite's CI needs something a fresh clone lacks** (a CLA signature, a lockfile install). Expected: the task reads the repository's workflow list before pushing and runs what it can locally. Pinned in Task 0 Step 2.

---

### Task 0: Access, clones and CI inventory

- [ ] **Step 1: Access**

Run: `for r in .github awesome-nimbus nimbus-security nimbus-client nimbus-vscode nimbus-web-clipper nimbus-sdk create-nimbus-connector nimbus-mcp-servers nimbus-connector-registry nimbus-recipes nimbus-raycast nimbus-statuspage nimbus-postmortem; do gh api repos/nimbus-agent/$r --jq '"\(.name) push=\(.permissions.push) admin=\(.permissions.admin) archived=\(.archived)"'; done`
Expected: `push=true admin=true archived=false` on all fourteen (it was so on 2026-11-12). A repository where it is not is reported and its slice is handed over as a diff (§ 5.12).

- [ ] **Step 2: Clone and read each repository's checks**

Run, per repository: `gh repo clone nimbus-agent/<repo> <scratchpad>/sat/<repo>` (a full clone), then `ls .github/workflows` and `gh api repos/nimbus-agent/<repo>/rulesets --jq '.[].name'`.
Expected: a list, per repository, of the checks a docs pull request must pass. Recorded in the scratchpad for the later tasks.

- [ ] **Step 3: Confirm ED1 is on `main`**

Run: `gh api repos/nimbus-agent/Nimbus/contents/docs/roadmap.md -H "Accept: application/vnd.github.raw" | grep -c -E '^### Phase (28|29|30) '`
Expected: `3`. If not, stop: this plan starts after ED1 merges.

---

### Task 1: ED2 — `.github` (`ECOSYSTEM.md`, `profile/README.md`)

**Files:** Modify `ECOSYSTEM.md`, `profile/README.md`

- [ ] **Step 1: Derive**

Run: `gh api repos/nimbus-agent/Nimbus/contents/packages/gateway/src/connectors/bundled-connector-registry.ts -H "Accept: application/vnd.github.raw" | grep -c '() => import('` (the connector count) and `gh repo list nimbus-agent --limit 100 --json name,isArchived,visibility` (the repository list).

- [ ] **Step 2: `ECOSYSTEM.md`**

The diagram's and prose's "~80 services" becomes the derived count rounded down to the nearest five with "about". `nimbus-sdk`'s role says the contract has TypeScript, Python and Go bindings. Add `nimbus-mcp` (the launcher for the Nimbus MCP server) under Surfaces and `nimbus-trust` (the signed trust feed) under Project infrastructure. Remove `nimbus-raycast`, `nimbus-statuspage`, `nimbus-postmortem`, `nimbus-connector-registry` and `nimbus-recipes` from their tables and list them in a new short "Retired" section, each with one line saying where its work went (linking the roadmap row) or that it is not planned. The "Where planning lives" table is unchanged. One sentence under "The shape" links to `Nimbus/docs/roadmap.md#direction` as the recorded direction, described as planned.

- [ ] **Step 3: `profile/README.md`**

The same count; the repository table gains the repositories it omits and loses the five retired ones; any sentence that says the main repository holds the connectors, or that Dependabot runs, is corrected against `Nimbus/CLAUDE.md`. The tagline is untouched.

- [ ] **Step 4: Verify and open**

Run: every link in both files with `gh api` or `curl -I` for external ones → Expected: no 404. Then the repository's own CI. Title: `docs: ecosystem map — current repositories, retired scaffolds, derived counts`.

---

### Task 2: ED3 — `awesome-nimbus` (`README.md`)

- [ ] **Step 1: Correct**

Links to `packages/sdk`, `packages/client`, `packages/vscode-extension` and `packages/mcp-connectors` become links to the repositories that hold them. The invariant range is replaced by a link to `Nimbus/docs/SECURITY-INVARIANTS.md` with no number. `nimbus-raycast` leaves "Companion Tools". `nimbus-mcp`, `nimbus-trust` and `nimbus-mcp-servers` are listed where they belong. The description of `create-nimbus-connector` matches that repository's own first sentence.

- [ ] **Step 2: Verify and open**

Run: a link check over `README.md` → Expected: no 404. Title: `docs: fix moved paths and list the current repositories`.

---

### Task 3: ED4 — `nimbus-security` (`README.md`, `invariants.md`)

- [ ] **Step 1: Replace the copied catalogue (D-ECO-8)**

`invariants.md` becomes a short page: what an invariant is in Nimbus (a production wiring site plus an enforcement test), the seven non-negotiables as the gateway states them, and a link to `Nimbus/docs/SECURITY-INVARIANTS.md` as the only list. No invariant is enumerated and no range or schema version is stated. `README.md` loses "runs through I30" and "V44" and points the same way. The disclosure policy and `security.txt` are untouched.

- [ ] **Step 2: Verify and open**

Run: `grep -n -E 'I[0-9]+|V[0-9]{2}' README.md invariants.md` → Expected: no invariant or schema number remains. Title: `docs: link to the gateway's invariant catalogue instead of copying it`.

---

### Task 4: ED5 — `nimbus-client` (`ROADMAP.md`)

- [ ] **Step 1: Derive**

Read `Nimbus/packages/gateway/src/ipc/agents-rpc.ts` for the agent methods the gateway serves and `src/agents.ts` here for the ones the client types.

- [ ] **Step 2: Rows**

Keep the file's existing rows. Add, unticked: typed methods for the remaining agents (naming which need an SDK change first, as the file already does); typed `resolve` and per-item `fetch`; the approval surface the agent door needs (list waiting proposals, answer one), marked as depending on `Nimbus` Phase 28 and on its spec for the method names.

- [ ] **Step 3: Verify and open** — the repository's `scripts/check-readme-surface.test.ts` still passes (`bun test`). Title: `docs(roadmap): the width the agent door needs`.

---

### Task 5: ED6 and ED7 — `nimbus-vscode`, `nimbus-web-clipper`

- [ ] **Step 1: `nimbus-vscode` `docs/ROADMAP.md`**

Correct the stale version sentence (the client pin and the surface it describes) against `package.json`. Add one unticked row: the editor as an approval surface for agent-door proposals, depending on `Nimbus` Phase 28 and on a typed client method. Link the gateway's § Direction once.

- [ ] **Step 2: `nimbus-web-clipper` `ROADMAP.md` and `README.md` (facts only, D-ECO-11)**

The README's release example matches the latest tag. The roadmap sentence that calls phase C2 unbuilt is corrected (C2 is marked shipped in the same file). The agent count is derived from the gateway. No row is added, parked or removed.

- [ ] **Step 3: Verify and open** — each repository's lint and test commands as its CI runs them. Titles: `docs(roadmap): the editor as an approval surface; version text corrected` and `docs: correct stale facts in the roadmap and README`.

---

### Task 6: ED8 — `nimbus-sdk` (`docs/ROADMAP.md`)

- [ ] **Step 1: Read the two unticked boxes and the gateway's record**

The boxes: "third-party connector/app registry design" and "manifest signature path proven end-to-end". The record: `Nimbus/docs/roadmap.md` § Phase 9.5 and § Spine S3.

- [ ] **Step 2: Tick only what the record proves**

A box is ticked only if the gateway text states that exact thing shipped, and the tick cites the gateway section. Where the gateway shipped something narrower or different (the registry design lives in the gateway, not in an SDK schema), the box stays unticked and gains one sentence saying what exists and what this box still asks for. The stale sentence about first-party connectors living in the monorepo is corrected.

- [ ] **Step 3: Verify and open** — the repository's docs checks. Title: `docs(roadmap): reconcile the registry and signature boxes with what the gateway shipped`.

---

### Task 7: ED9 — `create-nimbus-connector` (`docs/ROADMAP.md`)

- [ ] **Step 1: Read before adding**

The file already records the re-targeting to the `nimbus-mcp-servers` layout as an open design decision and the consolidation with `@nimbus-dev/create-connector` (Stage G). Confirm both by search.

- [ ] **Step 2: Add only what is missing (D-ECO-12)**

One sentence in Stage G naming the third overlapping scaffolder, the gateway's `nimbus scaffold` (including `--from-openapi`), with no decision. If the re-targeting row is absent, add it unticked; if present, leave it.

- [ ] **Step 3: Verify and open** — Title: `docs(roadmap): name the third scaffolder in the consolidation note`. If Step 1 shows nothing is missing, no pull request is opened and the report says so.

---

### Task 8: ED10 — `nimbus-mcp-servers` (new `ROADMAP.md`)

- [ ] **Step 1: Write `ROADMAP.md`**

A short file in the house style: what this repository owns (the connectors; the gateway owns sync and indexing), then unticked rows: MCP revision 2026-07-28 (the stateless revision; a successor to the elicitation-based consent in the standalone launcher); the cost connectors, pointing at the gateway's Phase 30 and at the slices already merged here; filling in the per-connector READMEs that are still a gateway quickstart; re-measuring the client-support matrix. This slice writes rows, not the READMEs or the measurement.

- [ ] **Step 2: Link it**

One line in `README.md` and in `docs/index.md` pointing at `ROADMAP.md`; `ECOSYSTEM.md`'s planning table already says each surface owns its own roadmap.

- [ ] **Step 3: Verify and open** — `bun test scripts/doc-links.test.ts`. Title: `docs: add a roadmap`.

---

### Task 9: ED11, part one — the five README notes

- [ ] **Step 1: One pull request per scaffold repository**

At the top of each `README.md`, a note: this repository is retired (owner decision, 2026-11-12) and archived; what it was meant to be, in one sentence; where the work went, as a link to the roadmap row (`nimbus-statuspage` → the *Status page draft* row in Phase 17; `nimbus-postmortem` → Phase 10's *Post-mortem generation* row; `nimbus-connector-registry` → Phase 9.5, which shipped the registry differently) or that it is not planned (`nimbus-raycast`, `nimbus-recipes`, each linking its § Rejected Directions entry). `NEW-SESSION-PROMPT.md` gains one first line saying the prompt is historical.

- [ ] **Step 2: Merge each when green**

---

### Task 10: ED11, part two — archive, after the owner confirms

- [ ] **Step 1: Ask the owner once more** (§ 5.10), naming the five repositories and that archiving is reversible.

- [ ] **Step 2: Only on a yes**, per repository: `gh api -X PATCH repos/nimbus-agent/<repo> -f archived=true`

- [ ] **Step 3: Guard** — before each call: `gh pr list -R nimbus-agent/<repo> --state open --json number --jq length` is `0` and the note of Task 9 is on the default branch.

- [ ] **Step 4: Verify** — `gh repo list nimbus-agent --limit 100 --json name,isArchived --jq '.[] | select(.isArchived) | .name'` lists exactly the five.

- [ ] **Step 5: The organisation-wide search (ED-f)**

For each non-archived repository, on its default branch: `gh api "search/code?q=org:nimbus-agent+<name>+in:file+extension:md"` for each of the five names, plus a local `git grep` in the clones. Expected: every hit is a "retired" note, a dated changelog entry, or the § Rejected Directions entries. Anything else is fixed in a follow-up pull request to that repository.

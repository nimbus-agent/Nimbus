# Author onboarding PR 4 — the Authors section and the S3 close-out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An **Authors** section on the docs site walks an extension author from scaffold to publish, and project 7, Phase 9.5 and Spine S3 are marked complete everywhere the status is stated.

**Architecture:** Seven Starlight pages under `packages/docs/src/content/docs/authors/`, one sidebar group in `packages/docs/astro.config.mjs`, content ported (condensed, not copied) from the repo docs that stay the reference. Then one status sweep across `docs/roadmap.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, `GEMINI.md` and the skills that restate the S3 status.

**Tech Stack:** Astro Starlight (`packages/docs`, TypeScript 6 pin), `starlight-links-validator` (internal links fail the build), lychee (external links, `docs-quality.yml`), markdownlint.

**Spec:** `docs/superpowers/specs/2026-11-04-author-onboarding-design.md` § 7 and § 8, branch `dev/asaf/author-onboarding-spec`. Owner ruling R4 (a docs-site section, not a separate site).

## Global Constraints

- Pages (in this order, sidebar group label **Authors**, inserted after **User Guide** and before **Reference**): `authors/index.mdx` (Overview), `authors/start.mdx` (Start: `scaffold extension`, `--from-openapi`, `extension clone`), `authors/build-and-test.mdx` (build, `extension install <path>`, `approve`, `connector tools`/`call` for ext ids if they apply — verify), `authors/evals.mdx` (`evals/*.eval.json`, `eval --package`, `eval --record`), `authors/sign-and-publish.mdx` (`keygen`, `sign`, `pack`, `publish`, key rotation, the official registry), `authors/funding-and-license.mdx` (`funding`, `license`, `sponsor`), `authors/verified-publishers.mdx` (what the badge means and how a publisher is verified, as the trust-feed docs describe it).
- Every command, flag, limit and message quoted must match the code on `main` and `docs/cli-reference.md`; when in doubt, link to the reference instead of restating.
- Links to repo docs are absolute `https://github.com/nimbus-agent/Nimbus/blob/main/docs/…` URLs (lychee checks them); links between site pages are site-relative (`/authors/start/`), which `starlight-links-validator` checks.
- The grant program is not mentioned (owner's, not built). The registry web page and the desktop tile are not claimed (open roadmap row).
- No new claims beyond what shipped; each page states its bounds where the reference does (e.g. clone copies built `dist/`, not source; the OpenAPI fetch is CLI-side and unledgered).
- `docs/contributors/extension-author-walkthrough.md` gains one line linking to the section (`https://nimbus-agent.dev/authors/`), and its stale line 5 ("not offered to the agent's model yet (that is PR 4)") is corrected: `--model` access shipped 2026-10-17 (`nimbus extension approve <id> --model`).
- Close-out (Task 2): the **Extension Author Hub** roadmap row ticked and rewritten (`/authors/` on the docs site); project 7 ✅ 2026-11-04 in 4 PRs (#1878, #1880, #1881, this PR); Phase 9.5 ✅ (all seven projects); **S3 ✅** with dates (active since 2026-10-11, closed 2026-11-04) and a short record in the S3 section; the "Current build slot" text says S3 is complete and names **S4 — Autonomous Agent** as next, NOT started (opening it is the owner's call). Still listed as open, unchanged: the owner's non-buildable items (`registry.nimbus-agent.dev` hosting, Verified Publisher pricing and KYC, the grant program, the 30-extension / 5-publisher acceptance bar) and the **Marketplace page and desktop tile** row.
- CLAUDE.md and GEMINI.md say the same thing (the status paragraph; S3 is no longer "the active slot").
- Run `bun run preflight:fast` and `bun run typecheck:tests` before pushing; build the docs site (`bun --cwd packages/docs run build`) so the links validator runs. Links leaving the Starlight collection (to `docs/*.md`) MUST be absolute GitHub URLs; the validator rejects relative paths outside `packages/docs`.

## Plan review record

Antigravity (2026-11-04) raised 6 findings. Applied 5: the sidebar item shape; the build command is `bun --cwd packages/docs run build` and `packages/docs/README.md` does not exist; links outside the collection must be absolute; a closed slot moves to `## Shipped` and its open rows are re-homed to S4; the walkthrough's stale line 5. Rejected 1: "I50 was not part of S3" — I50 (the Linux forwarder) shipped 2026-10-31, inside S3 (CHANGELOG line 115).

## Review Focus

1. A site-relative link to a page that does not exist fails the docs build (Task 1 runs the build).
2. A quoted flag that does not exist (e.g. `nimbus registry install`, which never existed) — every command is checked against `docs/cli-reference.md` (Task 1).
3. A status line left saying S3 is active or project 7 in progress (Task 2 greps every restatement).
4. CLAUDE.md and GEMINI.md drifting apart (Task 2 diffs the paragraph).
5. `audit:status-drift` and `audit:doc-refs` (Task 2).

---

### Task 1: The Authors section

**Files:** Create the seven pages above; Modify `packages/docs/astro.config.mjs` (sidebar group); Modify `docs/contributors/extension-author-walkthrough.md` (one link line).

- [ ] **Step 1:** Write each page with frontmatter `title` and `description` (Starlight), short sections, code blocks for commands, and a "Reference" link list at the end of each page pointing at the exact `docs/cli-reference.md` anchors.
- [ ] **Step 2:** Add the sidebar group as `{ label: "Authors", items: [{ label: "Overview", link: "/authors/" }, { label: "Start", link: "/authors/start/" }, …] }` — site-relative links with trailing slashes, the same shape as the existing groups (`index.mdx` routes to `/authors/`).
- [ ] **Step 3: Run** `bun --cwd packages/docs run build` (runs the links validator) and, from the repo root, `bun run lint:markdown` — PASS.
- [ ] **Step 4: Commit** `docs(site): an Authors section from scaffold to publish`.

### Task 2: Close project 7, Phase 9.5 and S3

**Files:** `docs/roadmap.md`, `docs/CHANGELOG.md`, `CLAUDE.md`, `GEMINI.md`, and any `.claude/commands/*.md` skill that states the S3 status or "project 7 … in progress" (grep).

- [ ] **Step 1:** `grep -rn "PR 3 of 4\|project 7\|active slot\|S3 (Open Surface) is\|S3 closes when" docs/roadmap.md CLAUDE.md GEMINI.md docs/CHANGELOG.md .claude/commands` and update every live status statement per Global Constraints; leave dated history entries alone.
- [ ] **Step 1b:** Move the S3 section from `## Active` to `## Shipped` as `### Spine S3 — Open Surface ✅`, the way S1 and S2 were moved, and update `## Contents` and `## Status Overview` to match. Reconcile EVERY unticked row under Phase 9.5 (e.g. **Bring your own registry**, **Starter packs (curated collections)**, **Community ratings and reviews**): tick a row only with the PR and date that shipped it (Starter packs shipped in project 4 PR 4, 2026-10-29; private registries in project 1, whose acceptance criterion is already marked met — check each row's exact wording against what shipped); a row that is still open is re-homed into `#### Carried into S4` (or a deferred list the roadmap already has, keeping the deferral reason) with its source row pointing there. The **Marketplace page and desktop tile** row is re-homed the same way. Nothing open may remain only under a closed slot.
- [ ] **Step 2:** Add the S3 record paragraph to the `### S3 — Open Surface` section (what shipped, in order, with dates and invariants I28, I43, I44, I46, I47, I48, I49, I50, I51, I52; what stays open).
- [ ] **Step 3:** CHANGELOG entry for 2026-11-04: the Authors section and the close-out.
- [ ] **Step 4: Run** `bun run audit:status-drift`, `bun run audit:doc-refs`, `bun run lint:markdown`, `bun run preflight:fast`, `bun run typecheck:tests` — PASS; `diff` the CLAUDE.md and GEMINI.md status paragraphs — identical.
- [ ] **Step 5: Commit** `docs: close project 7, Phase 9.5 and S3`.

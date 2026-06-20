# Nimbus GitHub PR Checks (App / Action) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 — Scale & Surface (Phase 12 Enterprise commercial-anchor surface; reuses Phase 5 T4 DORA data layer). Resequence reference: `docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md` §Track 2.
**Scope:** New `packages/github-pr-check/` (a third first-party GitHub Action, AGPL — sibling of the two existing actions) + a thin composite-action wrapper. Extends `packages/github-actions/shared/gha-io.ts` (reuse). **No `packages/gateway` source changes for the MVP** (it consumes only the already-shipped read-only HTTP API). Docs: `packages/docs/`. Optional later: one new read RPC handler in `packages/gateway/src/ipc/http-server.ts` (Wave 2, blast-radius) — additive, no write surface.

---

## Motivation / Goal

Make Nimbus's existing analysis visible *where engineers already are* — the pull request. Today the analysis exists (DORA, preflight, blast-radius) but only surfaces as CLI output or job annotations. A reviewer scanning a PR sees nothing. The goal: on every PR, post a single, well-formed comment that summarizes **preflight verdict** (active P1 incidents, failing CI on the target ref, merge conflicts) and **DORA posture** for the service, with a clear `ok | warn | block` verdict. This is the paid-team anchor: zero-config "Nimbus checks my PRs."

**The tension (called out in the task):** a GitHub *App* is, by definition, a cloud webhook surface. A naïve hosted App would receive a webhook on Nimbus's servers and call back into the user's machine — that is a phone-home relay that sees the user's private index, and it violates Non-Negotiable #1 (local-first) and #3 (no-plaintext-creds). **This design rejects the hosted-relay-by-default architecture** and resolves the tension below.

---

## Where this fits (roadmap home + not-already-shipped evidence)

**Already shipped (do not rebuild — confirmed in-tree):**

- `packages/github-actions/preflight-query/` (v0.1.0): a `node20` GitHub Action that calls the **read-only** Gateway HTTP API `GET /v1/preflight/deploy` and renders findings as **workflow annotations + job summary**. Source: `preflight-query/src/{main,render,output}.ts`; `action.yml` defaults `gateway-url: http://localhost:7474`, has `mode: warn|block|off`, `allow-gateway-failure`, and a `result-json` output.
- `packages/github-actions/annotate-action/` (v0.1.0): POSTs deploy annotations to the **I13 write surface** `POST /v1/deployments` (bearer = `http_api.deployment_token`).
- `packages/github-actions/shared/gha-io.ts`: the shared GHA I/O barrier — `safeString`, `emitAnnotation` (with `::`-injection escaping), `writeJobSummary` (64 KB cap), `makeSetOutput` (allow-listed output names). **Directly reusable.**
- Read-only HTTP API in `packages/gateway/src/ipc/http-server.ts`: `dispatchReadOnlyGet` serves `GET /v1/preflight/deploy`, `GET /v1/metrics/dora`, `/v1/items`, `/v1/audit`, `/v1/health`, `/v1/openapi.json` — all read-only.
- I13 write surface `packages/gateway/src/ipc/http-write-routes.ts`: `WRITE_ROUTE_ALLOWLIST` is a frozen 6-entry list; the **only** non-SCIM/non-policy/non-Teams write is `POST /v1/deployments`.
- Blast-radius agent `packages/gateway/src/agents/impact.ts` (`runImpact`); CLI `nimbus impact` (`packages/cli/src/commands/impact.ts`, `help.ts`).

**Not shipped (this is the gap):**

- No PR-comment posting surface — the existing actions write *annotations*, never a PR comment.
- No one-click install / composite-action wrapper.
- No `packages/github-pr-check/` (confirmed: `ls packages/` shows `github-actions`, no `github-app`/`github-pr-check`).
- No `GET /v1/preflight/deploy`-equivalent for blast-radius over HTTP (impact is IPC/CLI-only today).

So the gap is **a posting surface + zero-config wrapper**, not new analysis. YAGNI says: reuse the analysis, add only the comment.

---

## Approaches considered

### Approach A — **GitHub Action that posts the PR comment from inside the user's CI job** (recommended)

A new `packages/github-pr-check/` action runs *inside the customer's workflow*, on their **self-hosted runner** (same model as `preflight-query`). It:

1. Calls the local Gateway's **read-only** HTTP API (`GET /v1/preflight/deploy`, `GET /v1/metrics/dora`) — exactly the existing pattern.
2. Renders a single Markdown comment.
3. Posts/updates the comment via the **GitHub REST API using the job's own ephemeral `GITHUB_TOKEN`** (the `secrets.GITHUB_TOKEN` GitHub injects per-run; scope `pull-requests: write`). Find-and-update by a hidden marker so re-runs edit one comment instead of spamming.

- **Trade-offs:** + No Nimbus cloud service, no relay, no webhook receiver — the user's index never leaves their network; the GitHub token is GitHub's own per-job token (never stored in Vault, never in Nimbus). + Reuses `gha-io.ts` and the read-only API verbatim — near-zero Gateway change. + "One-click" is delivered as a published **composite action** (`nimbus-agent/pr-check@v1`) a team pastes into `.github/workflows`. − Requires the team to add a workflow file (one-time, ~8 lines) and a self-hosted runner with the Gateway reachable — *not* literally a Marketplace "Install" button. − Doesn't run for forks without the self-hosted runner.

### Approach B — Hosted GitHub App with a cloud relay back into the user's machine

A real GitHub App: install via Marketplace, webhook hits `nimbus-agent.dev/webhooks/github`, the relay tunnels to the user's Gateway, posts the comment.

- **Trade-offs:** + True one-click Marketplace install; works with GitHub-hosted runners. − **Violates Non-Negotiable #1**: a Nimbus-operated server sits in the data path and must reach the user's private index. − Requires a persistent inbound tunnel into the user's machine (attack surface, ops burden). − Webhook-secret + GitHub-App private key are Nimbus-held cloud secrets, not the user's Vault. **Rejected for MVP**; documented only as a future *optional* commercial upsell tier with an explicit "relay never persists index data; only proxies a read query you approve" contract — out of scope here.

### Approach C — GitHub App for identity only; analysis still local

Use a GitHub App purely to mint a short-lived **installation token** (so comments are authored as "Nimbus[bot]" not "github-actions[bot]"), but keep all analysis + posting inside the user's CI job (App private key lives in the user's Vault, used by the local action to mint the installation token at job time).

- **Trade-offs:** + Nicer bot identity + works in repos where `GITHUB_TOKEN` is restricted. + Still local-first (private key in *user's* Vault, not Nimbus cloud). − Adds a Vault key (`github.app.private_key`) and an installation-token mint step → needs a new I13-style consideration and more surface. − Marginal UX gain over the free `GITHUB_TOKEN`. **Defer to Wave 2** as an opt-in identity upgrade.

### Recommendation

**Approach A for MVP.** It is the only option that keeps the moat: the analysis and the index stay on the user's machine, the only token used is GitHub's own per-job `GITHUB_TOKEN` (never touches Nimbus or Vault), and it reuses the already-shipped read-only API + `gha-io.ts` almost verbatim. The "GitHub App" framing in the goal is best satisfied as a **published composite Action** (`nimbus-agent/pr-check@v1`) — the "one-click" is "add 8 lines of YAML," which is the honest, local-first version of one-click. Approach C is the natural Wave-2 identity upgrade; Approach B is a clearly-labelled future hosted upsell, not built now.

---

## Design (recommended)

### Architecture & components

New package **`packages/github-pr-check/`** (AGPL; structurally a clone of `preflight-query/` — `node20`, bundled standalone with `bun build` to `dist/index.js`):

```text
packages/github-pr-check/
  action.yml            # inputs: service, gateway-url, github-token, pr-number, mode, include-dora, timeout-ms, allow-gateway-failure
  package.json
  src/
    main.ts             # orchestrate: fetch → render → post
    fetch.ts            # GET /v1/preflight/deploy (+ /v1/metrics/dora) via the read-only API
    render.ts           # build the single Markdown comment (summary table + collapsible details + hidden marker)
    comment.ts          # find-or-update PR comment via GitHub REST (Octokit-free: bare fetch, GITHUB_TOKEN)
    output.ts           # setOutput(verdict, comment-id) via makeSetOutput allow-list
    *.test.ts           # bun tests per file (≥80% line+branch)
  README.md             # public-tier H2 sections (audit:package-readmes)
```text

Reuse `packages/github-actions/shared/gha-io.ts` for `safeString`, `writeJobSummary`, `makeSetOutput`, and the `::`-injection-safe escaping (the same relative-import-inlined-at-build pattern the other two actions use — no workspace dep introduced).

A thin **composite action** (`packages/github-pr-check/composite/action.yml` or a top-level `action.yml`) chains `preflight-query` (already exists) → `github-pr-check`, so a team references one action.

### Data flow

```text
PR opened / pushed
  → customer workflow (self-hosted runner)
     → [existing] preflight-query  → GET http://localhost:7474/v1/preflight/deploy   (read-only)
     → [new] github-pr-check
          → GET /v1/preflight/deploy  (+ optional GET /v1/metrics/dora)              (read-only, local Gateway)
          → render single Markdown comment (verdict + table + <details>)
          → GitHub REST: list PR comments → find hidden marker
               → PATCH existing comment  OR  POST new comment
                 (auth: secrets.GITHUB_TOKEN, never Vault, never Nimbus cloud)
  → comment visible to repo members only (private repo → private; never a public wiki/discussion)
```text

The user's private index never leaves the machine: every Gateway call is `GET` to `localhost`. The only outbound call is `GitHub REST → github.com`, carrying *only the rendered verdict text the action computed from already-public-to-the-team CI signals*, authenticated by GitHub's own job token.

### Forked PRs / `pull_request_target` (security-caveated)

On a `pull_request` event **from a fork**, GitHub downgrades `secrets.GITHUB_TOKEN` to read-only, so the comment POST/PATCH will 403. **v1 is internal-PRs-only:** the action runs on same-repo PRs; for a fork PR it detects the read-only token (or `github.event.pull_request.head.repo.fork === true`) and **skips posting with a one-line note**, never failing the step on a fork 403.

Public-repo / fork-PR comment posting is possible only via a `pull_request_target` workflow — that event runs in the context of the **base** repo and so carries a write-scoped token. This is offered as an **opt-in, documented, caveated** pattern, **never the default**:

> **SECURITY WARNING — do not run fork code in a `pull_request_target` job that talks to the Gateway.** A `pull_request_target` workflow executes with elevated, write-scoped credentials. Checking out and running untrusted fork code (its build, tests, or scripts) in the *same* job that queries the local read-only Gateway API is dangerous: the fork code can exfiltrate the elevated token or probe `localhost`. The opt-in recipe MUST NOT `actions/checkout` the fork ref, and MUST NOT run any fork-supplied step in the posting job — it posts only the verdict text the action rendered from the Gateway's own read-only response. The documented recipe will pin the base-ref checkout (no `head.sha`), scope the token to `pull-requests: write` only, and carry this warning inline.

### IPC / CLI surface

- **MVP: none added to the Gateway.** The action speaks the existing read-only HTTP API. No new `nimbus <cmd>`, no new RPC, no new write route.
- **Wave 2 (blast-radius in the comment):** add one read-only HTTP handler `GET /v1/impact?ref=<file-or-PR>&depth=N&service=<id>` in `dispatchReadOnlyGet` (`http-server.ts`) that calls the existing `runImpact` (`agents/impact.ts`) and returns the brief as JSON. This is purely additive to the **read** surface (`dispatchReadOnlyGet`), never to `WRITE_ROUTE_ALLOWLIST`. CLI `nimbus impact` already exists and is unchanged.

### Security: explicit check against the 7 Non-Negotiables

1. **Local-first** — ✅ Preserved. Analysis runs in the local Gateway; the action only `GET`s `localhost`. No Nimbus cloud service, no relay, no inbound tunnel. The index never crosses the network.
2. **HITL is structural** — ✅ Untouched. The action performs **no Nimbus write action**: it reads `GET` endpoints and posts a *GitHub* comment (a notification on a third-party system, not a mutation of the Nimbus index). It is structurally incapable of triggering `engine/executor.ts` `gate()` actions. **Explicit non-goal:** no "auto-merge"/"auto-remediate" button — any write-class action stays behind the local HITL executor and is reached only via `nimbus` CLI by a human. The comment may *suggest* a command; it never executes one.
3. **No plaintext credentials** — ✅ Preserved. The GitHub auth is `secrets.GITHUB_TOKEN`, GitHub's per-job ephemeral token, supplied by GitHub Actions to the job env — it is **never stored in Nimbus Vault, never in nimbus.toml, never logged**. `gha-io.ts` already strips control chars; `render.ts`/`comment.ts` MUST NOT echo the token (test asserts the token string never appears in any annotation/summary/output). The Gateway read API needs no credential for `localhost` reads (same as `preflight-query` today).
4. **MCP as connector standard** — ✅ Preserved. The action calls the Gateway HTTP API, not any cloud API on the engine's behalf; the engine still reaches GitHub only through the existing first-party GitHub MCP connector. The action is an *external CI consumer*, not part of the engine.
5. **Platform equality** — ✅ The action is `node20` + bare `fetch` (no native deps), identical to `preflight-query`; runs on any self-hosted runner OS. Tests run on the Ubuntu PR gate + 3-OS push matrix.
6. **AGPL-3.0 core / MIT sdk** — ✅ `packages/github-pr-check/` is a core action → **AGPL-3.0** (matches the existing `github-actions/*`). No license field changes.
7. **No `any`** — ✅ TS 6 strict; GitHub REST responses + Gateway JSON typed as `unknown` then validated/narrowed (reuse `safeString`/`safeInt` from `gha-io.ts`).

**Numbering note:** I28 is reserved for the MCP-server owner-sink (branch `dev/asafgolombek/phase7-mcp-gateway-server`). The I29/D22/V44-style numbers here follow the *proposed* global sequence in `2026-06-20-superpowers-specs-consolidated-review.md` §1 — these family ideas are mutually exclusive, so the actual number is the next-free at this spec's own merge time, reconciled by build order. (The MVP itself adds **no** new invariant/D/migration; the I29 below is only the *if-webhook-receiver* future reservation.)

**Invariant impact:**

- **No new invariant for the MVP.** The action touches no Gateway write surface; the read-only API is unchanged. **I13** (`WRITE_ROUTE_ALLOWLIST`) stays a frozen 6-entry list — the drift test in `security-invariants.test.ts` keeps passing because we add nothing to it.
- **I28 is RESERVED** (unmerged MCP-server owner-sink, `dev/asafgolombek/phase7-mcp-gateway-server`). This design does **not** assume Nimbus is an MCP server and does not consume I28.
- If a later wave adds a *local GitHub webhook receiver* on the write surface (Approach-B-lite), that would need a **new I29 — "inbound GitHub webhooks verified against `X-Hub-Signature-256` HMAC-SHA256 using a Vault-only `github.webhook_secret`; missing/invalid → 401 + audit; the webhook route is the sole inbound GitHub write path"** (wired in `http-write-routes.ts` as a new `WRITE_ROUTE_ALLOWLIST` entry, mirroring the Teams-events seam, with a `security-invariants.test.ts` block and a `check-nimbus-invariants.ts` static row). **This is explicitly out of MVP scope** and only noted so the reservation (I29, since I28 is taken) is on record.

**Schema impact:** **None — stays at V43.** The action is stateless w.r.t. Nimbus; it persists nothing locally. (A V44 `github_webhook_events` audit table is only needed under the rejected webhook-receiver approach — out of scope.)

**Fail-closed behavior:**

- Gateway unreachable + `allow-gateway-failure: false` → action fails the step with a clear message (`Nimbus Gateway unreachable at <url> — run 'nimbus start'`); it does **not** post a misleading "all clear" comment.
- Gateway unreachable + `allow-gateway-failure: true` (or `mode: off`) → skip, post nothing, exit 0 (never hang/retry-forever; honor `timeout-ms`, default 10000, same as `preflight-query`).
- `verdict: block` + `mode: block` → non-zero exit (CI red) *after* posting the comment.
- GitHub REST post fails (token lacks `pull-requests: write`, rate-limited) → fail the step with the GitHub status, never silently swallow; never leak the token in the error.

### Testing

- **Layer:** unit (`bun test`) per the existing GHA-action convention — `fetch.test.ts` (mock the read API at the HTTP boundary with a fetch fake), `render.test.ts` (golden Markdown + marker + injection escaping), `comment.test.ts` (find-or-update logic against a faked GitHub REST), `output.test.ts` (allow-listed outputs). Mirrors `preflight-query/src/*.test.ts`. **Coverage gate ≥80% line+branch per file** (baseline `{}` for new files — must clear on first add; verify with the coverage-floor build before first push).
- **Security tests (mandatory):** (a) the `GITHUB_TOKEN` value never appears in any emitted annotation, job summary, output, or thrown error message; (b) `render.ts` escapes `::`/CR/LF so a Gateway-supplied incident title cannot inject a workflow command (reuse `emitAnnotation`'s contract); (c) fail-closed: unreachable Gateway never produces an "ok" comment.
- **No new Gateway tests for MVP** (no Gateway code changes). Wave 2's `/v1/impact` handler would add a read-route test next to the existing `handleDeployPreflight` tests.
- Cross-platform: `bun run audit:cross-platform` clean (no hardcoded path separators); README passes `audit:package-readmes`.

---

## Non-goals (YAGNI)

- **No hosted GitHub App / cloud relay / webhook receiver** (Approach B) — rejected for MVP; documented as a future optional upsell only.
- **No auto-merge / auto-remediate / any write-back button** — would breach I2; comments are notifications + suggestions only.
- **No new Vault key, no GitHub-App private key** in MVP (Approach C deferred).
- **No new Gateway write route, no schema migration, no new invariant** in MVP.
- **No blast-radius in the comment for Wave 1** — preflight + (optional) DORA only; blast-radius is Wave 2 (needs the additive `/v1/impact` read handler).
- **No slash-command (`/nimbus check`) trigger** in Wave 1 — trigger on `pull_request` + `push`-to-PR only.
- **No Marketplace listing build/publish pipeline** beyond a versioned tag on the composite action — true Marketplace "Install" implies Approach B.
- **No replacement of `preflight-query`/`annotate-action`** — they coexist; the new action composes with them.

---

## Open questions

1. **"One-click" honesty.** Stakeholder expectation is a Marketplace Install button. MVP delivers "paste a composite action." Acceptable as v1, with Approach C/B as the upgrade path? (Recommendation: yes — local-first beats one-click.)
2. **DORA in Wave 1 or Wave 2?** Including `GET /v1/metrics/dora` in the comment is cheap (read-only, already shipped). Recommendation: include behind an `include-dora` input (default true) — it's the "team posture" hook for the paid anchor.
3. **Bot identity.** `GITHUB_TOKEN` posts as `github-actions[bot]`. Is that acceptable for v1, or is "Nimbus[bot]" (Approach C, Vault-held App key) needed for the commercial feel? (Recommendation: ship as `github-actions[bot]`; offer Approach C as a Wave-2 opt-in.)
4. **Forked PRs. — RESOLVED.** `GITHUB_TOKEN` on `pull_request` from forks is read-only by default; the comment post will 403. **v1 stays internal-PRs-only** (the comment posts on same-repo PRs; fork PRs are skipped with a documented note, never a 403-failed step). Public-repo / fork-PR comment posting requires a `pull_request_target` workflow (which runs with the *base* repo's write-scoped token); this is offered only as an **opt-in, documented, caveated** pattern, **not** the default. **SECURITY WARNING:** a `pull_request_target` workflow runs with elevated, write-scoped credentials in the context of the base repo — checking out and executing untrusted fork code *in the same job that queries the local Gateway* (read-only API on `localhost`) is dangerous: the fork code could exfiltrate the elevated token or probe the Gateway. The opt-in `pull_request_target` recipe MUST therefore **never check out or run fork code in the posting job** — it posts only the verdict text the action rendered from the Gateway's read-only response, and runs no fork-supplied build/test step. See §Design data-flow + §Forked PRs.
5. **Licensing gate.** If this is the paid anchor, where does tier enforcement live — in the action (checks a Vault `license.tier`?) or purely honor-system at MVP? (Recommendation: honor-system + read-only at MVP; tier gate lands with Enterprise Phase 12, not here.)
6. **Package name.** `packages/github-pr-check/` vs folding under `packages/github-actions/pr-check/` (sibling of the other two). Recommendation: **`packages/github-actions/pr-check/`** for consistency — keeps the shared `gha-io.ts` relative import trivial and groups all three actions.

---

## Acceptance criteria

1. A new action under `packages/github-actions/pr-check/` (AGPL, `node20`, bundled to `dist/index.js`) with `action.yml` inputs `service`, `gateway-url` (default `http://localhost:7474`), `github-token` (default `${{ github.token }}`), `pr-number` (default `${{ github.event.pull_request.number }}`), `mode` (`warn|block|off`), `include-dora` (default `true`), `timeout-ms` (default `10000`), `allow-gateway-failure` (default `false`); outputs `verdict`, `comment-id`.
2. On a PR, the action calls **only** `GET /v1/preflight/deploy` (+ optional `GET /v1/metrics/dora`) on the local Gateway and posts **exactly one** Markdown comment (summary table + `<details>` drill-down + hidden marker); a re-run **edits** that comment, never adds a second.
3. The comment renders a clear `ok | warn | block` verdict from the preflight envelope; `mode: block` + `verdict: block` exits non-zero *after* posting.
4. Fail-closed proven: unreachable Gateway with `allow-gateway-failure: false` fails the step with a `nimbus start` hint and posts **no** comment; with `true`/`mode: off` it posts nothing and exits 0; the action never hangs past `timeout-ms`.
5. The `GITHUB_TOKEN` value never appears in any annotation, job summary, output, or error (test-enforced). Gateway-supplied text cannot inject a workflow command (escaping test passes).
6. **No** change to `WRITE_ROUTE_ALLOWLIST`, **no** new Vault key, **no** schema migration, **no** new invariant for the MVP (I13 frozen-list drift test + `security-invariants.test.ts` stay green; `nimbus run preflight` passes).
7. Per-file coverage ≥80% line+branch on every new file (coverage-floor build green on Linux). `audit:package-readmes` and `audit:cross-platform` pass.
8. The 7 Non-Negotiables hold as documented in §Security; the spec records I28 as reserved and I29 as the *only-if-webhook-receiver* future invariant (explicitly not built here).
9. A composite action chains the existing `preflight-query` with `pr-check`, and `packages/docs/` documents the ~8-line workflow snippet (self-hosted runner + reachable Gateway).
10. **Forked PRs:** v1 is internal-PRs-only — a fork PR (read-only `GITHUB_TOKEN`) is **skipped with a documented note, never a 403-failed step**. The `pull_request_target` opt-in is documented **only** as a caveated pattern whose recipe never checks out or runs fork code in the posting job and carries the inline SECURITY WARNING (docs-reviewed).

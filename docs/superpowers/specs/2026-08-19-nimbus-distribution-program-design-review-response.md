# Review response: distribution program design

Disposition of [the review](./2026-08-19-nimbus-distribution-program-design-review.md)
against [the design](./2026-08-19-nimbus-distribution-program-design.md).
Every item was checked against the codebase before being accepted or rejected.

| # | Item | Disposition |
|---|---|---|
| 1 | `nimbus why` local-only? | **Answered + clarified in spec.** Sub-suggestion (output format) **deferred** — product change |
| 2 | Registration-consistency audit | **Gap accepted, placement rejected.** Added as a scoped task |
| 3 | npm publish rights | **Premise corrected.** The blocker is materially larger than assumed; spec updated |
| 4 | Hacktoberfest spam guard | **Policy accepted** and sharpened. **Bot deferred** (YAGNI) |
| 5 | 72-hour SLA automation | **Deferred** with an explicit trigger condition |

---

## 1. Does `nimbus why` need a local LLM? — No

**Verified.** `nimbus why` renders deterministically. `agents/why.ts` builds a
brief and passes it to `emitBriefWithSynthesis`; synthesis is an *optional
rewrite layer* gated on `[agents] synthesis` (default `"local"`), and
`agents/_lib/synthesize.ts` states the contract outright — **the deterministic
render is the floor** — with a catch so a synthesis failure cannot propagate.
A machine with no Ollama and no API key therefore gets the full deterministic
brief, not an error.

This is corroborated by the Gate 1 Linux container run, where `nimbus why`
returned real authorship while the embedding worker failed to initialise.

The spec was ambiguous enough to prompt the question, so **one clarifying
sentence has been added** to Section 1. The reviewer's fallback branch ("guide
the user if Ollama is missing") is already satisfied structurally by the
floor, plus the no-LLM footer and two-route `no_api_key` guidance shipped with
zero-config onboarding.

**Deferred:** changing `why`'s output format to surface last-3-commits,
dependents/dependencies and active authors. That is a product change, and this
program's own non-goals forbid product work. If the wedge copy pass shows the
output undersells itself, that is a separate, later decision.

## 2. Registration-consistency audit — real gap, wrong home

**The gap is real.** `scripts/gen-bundled-connector-registry.ts` scans
`packages/mcp-connectors/` and **writes a committed file**. Nothing regenerates
and diffs it in CI, so a connector directory added without rerunning
`gen:connector-registry` leaves a stale registry and no gate fires.
`test:connector-boot` cannot catch this: it boots every connector *the registry
ships*, so a connector missing **from** the registry is exactly the case it
cannot see.

Two adjacent gates already exist and should not be duplicated:
`audit:connector-entrypoints` (a `server.ts` guarded by `import.meta.main` must
export `startConnector()`) and `audit:connector-deps`.

**The proposed placement is rejected.** `scripts/structure-audit/check-nimbus-invariants.ts`
is the static complement to the **security** invariants — it enforces I1, the
vault-key allow-list, and D10/D12–D22. Registration drift is not a security
invariant; putting it there breaks the invariant triple rule (wiring + docs +
enforcement test per numbered invariant) and would leave a row in
`docs/SECURITY-INVARIANTS.md` that describes nothing.

**Accepted as:** a sibling script under `scripts/structure-audit/`, registered in
`scripts/lib/preflight-gates.ts` beside the two existing connector audits. The
cheapest correct form is regenerate-and-diff rather than a hand-maintained list
of registration sites, because it cannot drift from the generator.

Added to Section 2, Rung 1.

## 3. npm publish rights — the premise is wrong, and it matters

**Checked, and the answer inverts the suggestion.** `scripts/release/credential-registry.ts`
records `NPM_TOKEN` as `state: "forbidden"` — revoked 2026-07-19 — with the note:
*"Publishing is OIDC-only; both packages are set to `mfa=publish`, so a token
cannot publish. If this reappears, someone has reintroduced a bypass."*
`secret-health.yml` deliberately does not inject it.

So:

- **There is nothing to verify in release secrets.** The suggested check would
  find no npm token and, taken at face value, would conclude publishing is
  broken. It is not broken; it is deliberately token-free.
- **The monorepo has no npm publish path at all.** There are zero `npm publish`
  steps in `.github/workflows/`. `@nimbus-dev/sdk` and `@nimbus-dev/client`
  publish from their own satellite repositories, which is why both are live
  while `@nimbus-dev/mcp` — which lives in this monorepo at
  `packages/mcp-launcher` — is not.
- **The access-lockdown checklist the review asks for already exists and is
  stricter than proposed:** OIDC-only, `mfa=publish`, and a `forbidden` entry
  whose reappearance is itself treated as a detected bypass.

**Consequence for the spec:** "one publish away" was too glib. The real
precondition is a decision — configure npm trusted publishing (OIDC) for a
third package and add a publish path to the monorepo, **or** move
`packages/mcp-launcher` into its own satellite repo, matching the pattern that
already works for sdk and client. Section 3 now says this, and the sequencing
table carries the decision rather than assuming a trivial publish.

The documentation defect stands unchanged and independent: `CLAUDE.md` and
`GEMINI.md` describe the package as published, and it is not.

## 4. Hacktoberfest spam — policy accepted, bot deferred

**Policy accepted and sharpened.** The design already required an issue-first
policy; it now states the stronger, checkable form: an outside PR is reviewed
only if the contributor was **assigned the corresponding issue first**.
`docs/CONTRIBUTING.md` currently says only *"open a discussion before starting
any large PR"*, which is guidance, not a rule, and does not cover the
Hacktoberfest failure mode.

**Bot deferred.** An Action that auto-replies to unassigned PRs is
instrumentation for a problem that does not exist yet — the repository has had
no outside PRs at all. It also carries a real downside: the first genuine
outside contributor is the most likely person to trip an unassigned-PR
auto-reply, and being greeted by a bot telling them they broke a rule is a poor
first interaction on a funnel this thin. Revisit **in October, if and only if
volume appears**; a label plus a written policy is sufficient until then.

## 5. 72-hour SLA automation — deferred, with a trigger

**Deferred.** The commitment is a human one, and the queue it governs is
currently 15 open issues with effectively no inbound outside PRs. A scheduled
Action flagging items at the 60-hour mark instruments a queue that does not
exist; at this volume GitHub's own notifications already surface everything,
and the failure mode being guarded against is the maintainer not looking, which
a label does not fix.

`stale.yml` already exists and is the natural place to extend when the time
comes, so deferring costs nothing in future effort.

**Trigger condition to revisit:** sustained inbound — roughly five or more open
outside PRs or issues in a month, which in practice means after the
Hacktoberfest opt-in lands. Recorded here so the deferral is a decision with a
tripwire, not an omission.

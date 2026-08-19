# Review response: distribution program implementation plan

Disposition of [the review](./2026-08-19-nimbus-distribution-program-review.md)
against [the plan](./2026-08-19-nimbus-distribution-program.md). Each item was
run, not reasoned about.

| # | Item | Disposition |
|---|---|---|
| 1 | Backslash robustness in the registry regex | **Rejected** — the input cannot occur. Reasoning added to the code comment so it is not re-raised |
| 2 | Add `curl -L` to the link check | **Fix rejected, defect accepted.** No repo redirects; the check is *flaky*, which `-L` does not address. Replaced with retry flags |
| 3 | `npm org ls` may hang without auth | **Premise rejected** (it fails fast in ~1s), **hardening accepted**, and the run surfaced a fact worth recording |

---

## 1. Backslashes in the generated registry — cannot occur

**Checked.** `scripts/gen-bundled-connector-registry.ts` builds each entry from a
template literal:

```typescript
`  ${JSON.stringify(id)}: () => import("../../../mcp-connectors/${id}/src/server.ts"),`
```

The separators are **literal characters in the template**, not the output of
`path.join` or any other path API, so no platform can change them. The only
interpolated value is `id`, which comes from a `readdirSync` directory entry
name and therefore never contains a separator of either kind.

Confirmed against the committed artifact: `packages/gateway/src/connectors/bundled-connector-registry.ts`
contains **zero** backslashes.

Adding a normalization pass would be dead code guarding an input that cannot
exist, and dead defensive code is worse than none — it implies a hazard that
isn't there and invites the next reader to preserve it.

**Change made:** none to the logic. The reasoning is now a comment in the
implementation block in Task 2, Step 3, so the same question is answered at the
point where someone would ask it.

## 2. `curl -L` — right that the check is unsound, wrong about why

**Measured, twice, across all seven satellite URLs.** Every repository returns
`200` **directly**; not one redirects. So `-L` changes nothing about the failure
the review predicted, because that failure does not occur.

What the measurement *did* surface is a real defect the review did not name:
the check is **flaky**. Two runs of the identical loop produced a `000` —
`nimbus-sdk` on one pass, `awesome-nimbus` on another — on repositories that
were live both times. `000` is curl reporting no response at all, and a plan
step that says "expected: 200" turns that transient into a false failure and,
worse, into a false instruction to delete a live row from the README.

**Change made:** `--retry 3 --retry-all-errors --max-time 15`, plus explicit
instructions that `000` is not a verdict and that a `404` means fix-the-URL
rather than assume-the-repo-is-gone.

**`-L` is now explicitly forbidden in the step, with the reason.** Following
redirects would mask the one case genuinely worth catching: a renamed repository
answers `301` at its old URL, and a README quietly relying on GitHub's rename
redirect is a stale link waiting to break the day that redirect is retired.
Suppressing that signal is a downgrade, not a hardening.

The step also now says why it is not redundant with Step 1's `gh repo view`
check: `gh` validates repository *names*, this validates the *URL as written in
the markdown*, which is what catches a typo.

## 3. `npm org ls` hanging — it does not, but the run was still worth making

**Ran it, timeout-guarded.** Both `npm whoami` and `npm org ls nimbus-dev` fail
with `E401` in roughly a second. npm does not prompt and does not open a
browser for a read command; that behaviour belongs to `npm login`. So the plan
was not exposed to the hang the review anticipated.

Two notes on the proposed remedy: `--no-audit` is not a valid flag for
`npm org` and would itself be an error, and "similar non-interactive flags" is
not something to write into a plan without naming one that exists.

**Changes made anyway, because the run paid for itself:**

- `timeout 30` added to the probe — insurance is cheap, and an executing agent
  blocked on a prompt is expensive.
- **The verified result is now recorded in the step:** there is no npm
  authentication on this machine at all. That is a genuine input to Task 7's
  decision rather than a curiosity — it means publishing will happen from CI
  under OIDC regardless of which branch is chosen, which is consistent with
  `NPM_TOKEN` being `forbidden` and argues for the branch whose CI publish path
  already exists.

The step now presents `E401` as the expected result, so an executor does not
mistake it for a blocker and stop.

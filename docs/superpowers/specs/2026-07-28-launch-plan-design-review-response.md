# Review response: Nimbus launch — prove-then-launch

Responds to [2026-07-28-launch-plan-design-review.md](./2026-07-28-launch-plan-design-review.md).
Design updated: [2026-07-28-launch-plan-design.md](./2026-07-28-launch-plan-design.md).

Summary: two points accepted and folded into the design, two deferred because
the capability already exists and the review did not check. One additional
correction was found while verifying the review.

| # | Review point | Decision |
| --- | --- | --- |
| 1 | Automated quickstart smoke test in CI | **Accepted, reframed** — extend the existing workflow |
| 2 | Define zero-config `nimbus why` fallback | **Deferred — already implemented** |
| 3 | New `nimbus debug-report` command | **Deferred — `nimbus doctor` already covers it** |
| 4 | Connector audit and tiering | **Accepted, promoted to a blocking task** |
| 5 | *(found during review)* Telemetry claim was imprecise | **Fixed** |

## 1. CI smoke test — accepted, but it is an edit, not a new file

The underlying point is right: Gate 1 is a manual one-off and will regress the
moment someone touches the gateway. The proposed remedy, a new
`.github/workflows/smoke-test.yml`, would duplicate infrastructure that exists.

`.github/workflows/install-smoke.yml` already runs a 3-OS matrix
(`ubuntu-24.04`, `macos-14`, `windows-2022`), stages real built binaries,
executes `install.sh` / `install.ps1` against a sandboxed `HOME` /
`LOCALAPPDATA`, and asserts that uninstall removes the binaries and strips the
PATH marker block.

Its two real gaps are now recorded in the design:

- It only invokes `nimbus --help`, which proves the installer placed files
  rather than that the product works — exactly the #895 hole.
- Its `paths:` filter covers only `scripts/install/**`,
  `scripts/package-linux-installers.ts`, and two workflow files, so a gateway
  change that breaks `nimbus init` never triggers it.

One correction to the review's mechanics: it suggests the workflow "downloads
the compiled binary or executes `install.sh`". On a pull request those are not
interchangeable. `install.sh` fetches the **latest published release**, so
running it verbatim on a PR would test the last release rather than the proposed
change. The existing workflow already handles this correctly by building the PR's
binaries and staging them into a fake release directory. That distinction is
worth preserving: PR-time runs must exercise the PR's code, while verifying the
real download path belongs to a post-release check.

## 2. Zero-config `nimbus why` — already built

The review asks what `nimbus why` does with no LLM configured, and proposes
building a local-only fallback. That fallback exists and was executed on
v1.4.1 during this session, on a clean sandboxed config with no credentials and
no LLM:

```text
# Why
`auth.ts:1` in `.../demo-repo`

## Authorship
- **Test User · 0acda0d64bbe** — 2026-07-28
  add auth helpers

## Gaps
- ...

_Rendered deterministically — configure an LLM for prose synthesis._
```

That is the suggested behaviour: index-derived authorship, explicit gaps, and a
closing line pointing at LLM configuration. The README's claim that the
quickstart works with no LLM is accurate.

The only residual suggestion is cosmetic — a more prominent console block
advertising Ollama setup. That is a product change, and the design's
no-new-features-before-launch rule excludes it. Reconsider after Gate 2 if
testers actually stall there.

## 3. `nimbus debug-report` — `nimbus doctor` already exists

The need is real: chat-based troubleshooting of alpha testers is slow, and the
no-telemetry constraint means there is no passive fallback. But the CLI already
ships `nimbus doctor`, which reports Bun version, Vault availability, config
validity, index item count, per-connector health, gateway IPC state, and the
data-dir and gateway-state paths — and degrades usefully when the gateway is
down, which is the case that matters most.

`nimbus diag` is deliberately *not* the answer: it calls `diag.snapshot` over
IPC, so it is unavailable precisely when the gateway will not start.

Building a third command is unjustified. The design now carries two small tasks
instead: confirm `doctor` output is safe to paste publicly (it prints filesystem
paths), and put it first in the tester troubleshooting instructions.

## 4. Connector audit — accepted and promoted

The design already flagged the "80+ services" claim as a launch risk. The
review's contribution is the concrete mechanism, which is adopted: a
`scripts/audit-connectors.ts` that maps the connector manifest to implemented
tool endpoints, so the answer is reproducible rather than a one-time
spreadsheet. It is now a blocking pre-launch task rather than a caveat, driving
a Tier 1 list for launch copy and an honest restatement of the count.

The review's third sub-suggestion — in-product warnings when configuring a stub
connector — is deferred. Whether it is needed depends on the audit's output, and
building it first is speculative work against the no-new-features rule.

## 5. Correction found while verifying the review

The design originally asserted that Nimbus has "no account, no relay, no
analytics". The first two hold; the third was imprecise. An opt-in,
aggregate-only telemetry collector exists in
`packages/gateway/src/telemetry/`, with a configurable endpoint and a flush
scheduler, defaulting to `[telemetry] enabled = false` and disableable via
`nimbus telemetry disable`.

This does not change the conclusion — that surface still cannot measure the
launch, because enabling it by default would contradict the pitch and asking
testers to opt in yields a self-selected sample — but the design now states the
position accurately.

It also surfaced a launch-messaging risk now recorded in the design:
`docs/cli-reference.md` documents a default endpoint of
`https://telemetry.nimbus-agent.dev/v1/collect`. A reader who finds that string
without noticing `enabled = false` will conclude Nimbus phones home. The launch
copy should state the default-off position plainly rather than wait to be asked.

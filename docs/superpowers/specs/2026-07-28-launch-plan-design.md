# Nimbus launch — prove-then-launch design

> **Status:** approved design, not yet planned.
> **Date:** 2026-07-28.
> **Scope:** getting Nimbus from zero outside users to a public launch that
> produces retained users. Not a product-feature spec.

## Context

Nimbus is already published in every mechanical sense:

| Channel | State as of 2026-07-28 |
| --- | --- |
| GitHub repo | Public since 2026-04-07, AGPL-3.0, 20 topics |
| Docs site | Live at `nimbus-agent.dev`, HTTPS approved |
| npm | `@nimbus-dev/sdk` 1.7.1, `@nimbus-dev/client` 0.13.0 |
| Package managers | winget, Homebrew, Scoop, apt, yum |
| Native installers | `.msi`, `.pkg`, `.rpm`, `.deb`, AppImage |
| VS Code | Extension published |
| Positioning copy | `docs/launch-messaging.md`, `docs/audiences.md` |

Despite that: **3 stars, 0 forks, and no known user other than the author.**

The bottleneck is not packaging or readiness. It is that nobody knows Nimbus
exists, and that its first-run path has never been executed on a machine the
author does not own.

The severity of that second point is established, not speculative. PR #895
(merged 2026-07-28) fixed a bug where `nimbus init` **could never index** —
`connector.sync` rejected every local syncable. It survived a suite of more than
10,000 passing tests and a recorded demo cast, because the unit tests injected a
fake `syncFilesystem` and the cast ran against `scripts/cast-driver/fake-gateway.ts`.
It died the first time anyone ran the flow against a real gateway.

## Goal and non-goals

**Goal:** real users who install Nimbus, get to the "aha", and are still using it
weeks later.

Retention is the target, explicitly over reach. Twenty engineers who rely on it
beats two thousand stars from people who never ran `nimbus init`.

**Non-goals:**

- Stars, trending, or front-page placement as an end in themselves.
- Contributor recruitment. Worth doing later; it is a different funnel.
- Shipping new features before launch — specifically the `why` hover UI. The
  CLI already demonstrates the value, and feature work extends the runway
  without reducing launch risk.
- Paid promotion and Product Hunt. Wrong audience for an AGPL, local-first CLI
  aimed at on-call engineers.

## The binding constraint: effectively no telemetry

Nimbus's core claim is that nothing leaves the machine — no account and no
relay. The precise position is narrower than "no analytics at all": an
**opt-in, aggregate-only** telemetry collector exists
(`packages/gateway/src/telemetry/`), it defaults to `[telemetry] enabled =
false`, its endpoint is configurable, and `nimbus telemetry disable` writes a
local marker that short-circuits the flush scheduler.

That surface cannot be used to measure the launch, for two reasons. Turning it
on by default would contradict the pitch in front of the audience most likely
to check. Leaving it off but asking testers to enable it produces a
self-selected sample that is worse than no data while still spending trust.

Consequences, which shape the rest of this design:

- Retention cannot be measured directly. It can only be inferred from voluntary
  signals (GitHub Discussions, issues, direct conversation) and coarse public
  proxies (release-asset download counts, npm download counts, repo traffic).
- Because post-launch feedback is near-silent by construction, the private alpha
  is **not optional**. It is the only stage that yields a *reason* for a bounce
  rather than a number that failed to move.

**Launch-messaging note:** `docs/cli-reference.md` documents a default endpoint
of `https://telemetry.nimbus-agent.dev/v1/collect`. A reader who finds that
string and does not notice `enabled = false` will assume Nimbus phones home.
State the default-off position plainly in the launch copy rather than waiting to
be asked.

## Structure: three blocking gates

Gates rather than dates. A schedule cannot tell you whether first-run works.

| Gate | Question it answers | Exit criterion |
| --- | --- | --- |
| 1. Foreign-machine proof | Does the README quickstart work on a box that isn't the author's? | Clean Linux and Windows both complete `install` → `init` → `why` with zero manual intervention |
| 2. Private alpha | Do real engineers reach the aha unaided? | At least 5 testers reach `nimbus why` on their own repo without help; at least 3 still using it 14 days after their own first run |
| 3. Public launch | Does attention convert into users? | Channels fired lowest-stakes to highest, Show HN last |

No gate opens until the previous one's exit criterion is met.

## Gate 1 — foreign-machine proof

**What is tested:** the README quickstart verbatim, which is the
`install.sh` / `install.ps1` path — *not* the `.msi`. The scripts live in
`scripts/install/unix/` and `scripts/install/windows/` and today are covered
only by packaging tests (`scripts/package-linux-installers.test.ts`) and URL
tests (`scripts/release/documented-asset-urls.test.ts`). Nothing executes them
on a machine without a developer toolchain.

The sequence, on a box with no Bun, no repo checkout, and no prior Nimbus
config:

```bash
curl -fsSL https://github.com/nimbus-agent/Nimbus/releases/latest/download/install.sh -o /tmp/nimbus-install.sh
bash /tmp/nimbus-install.sh
nimbus --version
cd <a repo that is not Nimbus>
nimbus init
nimbus why <file>:<line>
```

**Environments.** The author's host is Windows 11 Home, which has neither
Hyper-V nor Windows Sandbox, so true local VM isolation on Windows requires
third-party virtualisation or a cloud VM.

| OS | Method | Confidence |
| --- | --- | --- |
| Linux | Clean `ubuntu:24.04` container with no Bun preinstalled | High — closest to a real new user |
| Windows | A fresh local user account (clean `%LOCALAPPDATA%` and PATH), or a free-tier cloud VM, or VirtualBox | Medium via user account, high via VM |
| macOS | A CI `macos-latest` job running `install.sh`, or deferred to a Gate 2 tester who owns a Mac | Lowest — carried forward as a known unknown |

**Deliberate choices:**

- **Index a repo that is not Nimbus.** Clone something mid-sized and
  unfamiliar. Indexing the repo the tool was developed against reproduces the
  same blind spot as testing against the author's own config.
- **No LLM and no credentials configured.** The README promises the quickstart
  works bare; verify the deterministic render rather than assuming it.
- **Every break gets a regression test at the real-gateway layer.** A fix
  covered only by a unit test with an injected fake is not covered. That is
  exactly how #895 shipped.

**Locking the gain — extend the workflow that already exists.** A one-off manual
pass regresses the moment someone touches the gateway.
`.github/workflows/install-smoke.yml` already runs a 3-OS matrix
(`ubuntu-24.04`, `macos-14`, `windows-2022`) that stages real built binaries,
executes `install.sh` / `install.ps1` against a sandboxed `HOME` /
`LOCALAPPDATA`, and verifies that uninstall removes the binaries and strips the
PATH marker block. It does **not** need replacing. It has two gaps that are
precisely the #895 hole:

- **It only runs `nimbus --help`.** That proves the installer placed files, not
  that the product works. Add `nimbus init` against a small repo checked out
  during the workflow, then `nimbus why <file>:<line>`, asserting exit codes and
  a non-empty index.
- **Its `paths:` filter is too narrow.** It triggers only on
  `scripts/install/**`, `scripts/package-linux-installers.ts`, and the two
  workflow files. A gateway change that breaks `nimbus init` never fires it.
  Widen the trigger so gateway and CLI changes are covered.

Note also that the workflow carries a stale comment asserting `nimbus --version`
does not exist. It does — v1.4.1 prints `1.4.1`. Worth correcting while editing
the file, since the comment will otherwise mislead the next author.

Because macOS runs in this matrix, extending the workflow is also the cheapest
way to close the macOS gap in the table above.

**Exit:** Linux and Windows both complete unaided. macOS either passes in the
extended `install-smoke` workflow or moves into Gate 2 explicitly labelled as
unverified.

## Gate 2 — private alpha

**Purpose:** learn *why* people stop, while it is still possible to ask.

**Recruiting**, targeting 5–10 engineers in the ICP (SRE, platform, on-call),
roughly in descending order of yield:

- The author's own network and former colleagues.
- zaalgol, and anyone he can reach.
- Local-first, MCP, and self-hosted communities where the author already
  participates as a member — reaching out individually, not announcing.
- Individual replies to people publicly describing on-call context problems.

Recruitment is deliberately private. A public post here would spend Gate 3's
ammunition before the funnel is known-good.

**How learning happens without telemetry.** Each tester is asked for either a
15-minute screenshare of their *first* run, or an async note answering three
questions: where did you stop, what did you expect to happen, and would you run
it again next week. The screenshare is worth substantially more — testers stall
in places nobody predicts, and a survey will not surface it.

**Bug reports without telemetry — use the command that already exists.**
Troubleshooting an alpha tester over chat is slow and lossy. `nimbus doctor`
already reports Bun version, Vault availability, config validity, index item
count, per-connector health, gateway IPC state, and the data-dir and
gateway-state paths — and it degrades usefully when the gateway is down, which
is the failure mode that matters most here. (`nimbus diag` is the wrong tool for
this: it calls `diag.snapshot` over IPC, so it is unavailable exactly when the
gateway will not start.)

Two small tasks rather than a new command:

- Confirm `nimbus doctor` output is safe to paste in public. It prints
  filesystem paths today; if those are sensitive, redact before recommending it.
- Put "run `nimbus doctor` and paste the output" in the tester instructions as
  the first troubleshooting step.

**Exit:** at least 5 testers reach `nimbus why` on their own repo unaided, and
at least 3 are still using it 14 days after their own first run. Each tester's
clock starts independently, so the gate does not wait on a single cohort date.
Failing this with hand-picked friendly
users is a signal that a public launch would not have worked either — that is
the gate doing its job, and the correct response is to fix the product, not to
proceed.

## Gate 3 — public launch

**Sequencing, lowest-stakes first**, so each channel de-risks the next. Channels
are spaced out rather than fired on a single day.

1. MCP directories and relevant `awesome-*` lists — low stakes, durable,
   high-intent traffic.
2. Lobsters, then r/selfhosted — technical, forgiving, tolerant of AGPL.
3. r/devops and r/sre — the actual ICP.
4. Show HN — last, once the funnel is known-good.

Show HN is treated as effectively one-shot per project, which is why it is
last.

**Assets already in the repo:** the 15-second asciinema cast, `docs/og-card.png`,
and the positioning in `docs/launch-messaging.md`.

**Two launch-specific risks:**

- **The honesty guardrails in `docs/launch-messaging.md` are load-bearing.**
  They forbid describing the `why` hover UI as shipped, and forbid describing
  the egress ledger as capturing raw network traffic — it records the agent's
  dispatched actions at the `I29` executor chokepoint, and is not a firewall or
  host DLP. A technical audience will find any overclaim, and being caught once
  costs more than the launch earns.
- **The "80+ services" claim invites audit.** Some connectors are stubs. A
  stranger who connects one and gets nothing suffers a trust hit at the worst
  possible moment.

**Connector audit — a blocking pre-launch task, not a caveat.** Before Gate 3
opens, produce an inventory mapping every connector in
`CONNECTOR_VAULT_SECRET_KEYS` to whether it is verified working, read-only, or a
stub. A script (`scripts/audit-connectors.ts`) that walks the connector manifest
and checks for implemented tool endpoints is the cheap way to generate it, and
it keeps the answer reproducible rather than a one-time spreadsheet.

The inventory drives two decisions:

- **Promote a "Tier 1" list.** Launch copy names the connectors known to work
  end-to-end instead of a headline count. A specific, honest list of well-tested
  integrations converts better with this audience than a large number that
  invites someone to find the weak one.
- **Restate the count honestly.** If the verified number is materially below
  80, change the README and launch copy to the real figure. This is the same
  discipline as the existing honesty guardrails, applied to a claim they do not
  currently cover.

Graceful in-product handling of stub connectors — a warning at configure time
rather than silence — is deferred. Whether it is needed is a decision the audit
makes for us, and building it before knowing the number is speculative work
against the no-new-features rule.

## Measurement

Given the no-telemetry constraint, these are the available signals, and their
known weaknesses:

| Signal | Source | Weakness |
| --- | --- | --- |
| Release-asset download counts | GitHub API per release asset | Counts downloads, not successful installs or use |
| npm download counts | npm registry for `@nimbus-dev/*` | Dominated by CI and mirrors |
| Repo traffic, stars, forks | GitHub repo insights | Attention, not retention |
| Discussions and issue quality | GitHub | Only the vocal minority; silence is ambiguous |
| Gate 2 tester check-ins | Direct conversation | Small sample, friendly bias |

No single number here proves retention. The Gate 2 cohort remains the most
trustworthy read, which is another reason not to skip it.

## What success looks like

Ninety days after Gate 3 opens: a double-digit number of engineers who installed
Nimbus, reached `nimbus why`, and returned to it in a later week — evidenced by
Discussions activity, issues that describe real usage rather than install
failures, and Gate 2 testers still running it.

Stars and traffic are reported but are not the target.

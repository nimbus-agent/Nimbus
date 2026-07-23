# Nimbus Infrastructure Roadmap

The delivery machinery for everything the org builds: CI, release automation,
PR review, and cross-repo coordination.

> **Three roadmaps, three axes.** [`roadmap.md`](./roadmap.md) is authoritative
> for **what the gateway does** — phases, acceptance criteria.
> [`ecosystem-roadmap.md`](./ecosystem-roadmap.md) is authoritative for **when
> capability becomes reachable** — client surface width. This file is
> authoritative for **how it gets built, reviewed and shipped**.
>
> On disagreement about gateway capability, `roadmap.md` wins. On disagreement
> about client reachability, `ecosystem-roadmap.md` wins. This file yields to
> both and owns only the machinery.

---

## The pattern this exists to break

**Controls stop where they were written.** Three instances, found across
unrelated areas of the org:

| Control | Written in | Where the risk is | Propagation |
| --- | --- | --- | --- |
| `audit:action-sha-pins` | `Nimbus` | the satellites — pins already drifted | never made |
| `.coderabbit.yaml` (tuned) | the 4 satellites | `Nimbus` — 30 invariants, reviewed stock | never made |
| `ci-secrets.md` completeness claim | when authored | `secret-health.yml`'s own credentials | never made |

Two point in opposite directions, so this is not "the periphery lags." A control
here is scoped to whatever context its author was in, and nothing carries it
further — not to another repo, not to a later day.

**Operating principle:** every sub-program ends in a gate a machine can check. A
sub-program is done when its gate is green in CI and would go red if the
property regressed — not when its code merges. A control that has stopped
covering the risk looks exactly like one that is passing; only a gate that would
go red tells them apart.

---

## Sub-programs

Design of record:
[`superpowers/specs/2026-07-23-org-infrastructure-program-design.md`](./superpowers/specs/2026-07-23-org-infrastructure-program-design.md).

| | Sub-program | Status | Gate |
| --- | --- | --- | --- |
| P1 | Org CI Foundation | 🔨 in progress | Org-wide SHA-pin + ruleset drift sweep goes red on any repo |
| P2 | Release Train | ⬜ not started | A publish that fails to open its downstream PR fails a staleness check |
| P3 | Review Layer | ⬜ not started | An invariant violation is caught in CI, not only in local `preflight` |
| P4a | Main-CI concurrency | ⬜ not started | Every commit on `main` has a completed CI run |
| P4b | Latency | ⬜ not started | Per-job wall-clock tracked; regressions visible |
| P5 | Org Legibility | ⬜ not started | `audit:secret-inventory` fails on any workflow secret missing from `ci-secrets.md` |
| P6 | Access & Contribution Model | ⬜ not started | Every repo reachable through a team; contributor-two switches live in checked-in config |

**Sequence:** P1 → P6 → P2 → P5 → P3 → P4b. Three items ignore the sequence and
land immediately: P4a, `nimbus-client` rulesets, and the DCO decision.

---

## How to update this document

- A sub-program is **done** when its gate is green in CI, not when its code
  merges.
- When a gate lands, record the command that runs it, so the claim is checkable.
- When this file and [`roadmap.md`](./roadmap.md) disagree about gateway
  capability, `roadmap.md` wins — fix this one.

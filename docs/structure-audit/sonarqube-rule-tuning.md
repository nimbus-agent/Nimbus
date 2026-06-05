# SonarQube rule tuning — B3 audit

This file is empty by design. It is populated **only if** Phase 2's first
SonarQube analysis run produces unacceptable signal-to-noise on the default
Sonar Way profile, requiring explicit rule disables.

## Phase 2 verification

**Date:** 2026-05-01
**SonarCloud project:** `asafgolombek_Nimbus`
**Profile in use:** Sonar Way (default)

Reviewed the SonarCloud findings produced against PR #135 (Phase 1 close).
Findings were Issues, not rule-disable candidates — the rule profile is
producing actionable signal at acceptable noise levels for this codebase.

**Outcome:** No rules disabled. Sonar Way profile retained as-is for B3.

Re-evaluate at B3 close (Phase 3) — if the top-5 fix work surfaces
new noise patterns, populate the disable table below.

## 2026-06-05 — Cleanup 6

Project key migrated `asafgolombek_Nimbus` → `nimbus-agent_Nimbus` (org
`asafgolombek` → `nimbus-agent`); the old key 404s. The CI step that disables
SonarCloud Automatic Analysis was pointed at the dead key, so the live project
had been running autoscan (no `lcov` coverage, `cpd.exclusions` ignored) — fixed
in `sonar-project.properties` + `.github/workflows/_test-suite.yml`.

**Policy for Cleanup 6: fix in code, do not disable rules.** No rule is added to
the disable table. The only inline suppression introduced is `typescript:S6324`
on the ANSI-escape regex in `scripts/cast-driver/normalize.ts` (literal ESC/BEL
bytes are intrinsic to OSC parsing; mirrors the existing `biome-ignore`). If the
S1313 IP-literal sweep cannot convert a site to `localhost`, a single
`typescript:S1313` suppression on one shared loopback constant may be added and
will be recorded here.

| Rule | Reason | Date | Where |
|---|---|---|---|
| _none_ | Sonar Way verified clean for B3 scope | 2026-05-01 | `sonar-project.properties` |

If you disable a rule, record:

- Rule key (e.g., `typescript:S1135`)
- Reason (one sentence; tie to a non-negotiable, an existing test, or a stylistic
  decision documented in `CLAUDE.md` / `docs/architecture.md`)
- Date
- Disabled in: `.sonarcloud.properties` / SonarQube web UI / etc.

Format:

| Rule | Reason | Date | Where |
|---|---|---|---|
| `typescript:Sxxxx` | … | YYYY-MM-DD | … |

If Phase 2 does not need to disable any rule, this file remains empty and is
removed at B3 close.

Source spec: B3 structure audit design § 4.1.

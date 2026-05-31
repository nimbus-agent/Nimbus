# SonarCloud baseline — cleanup pass 2

Project `asafgolombek_Nimbus` (org `asafgolombek`). Snapshots captured via
`Invoke-RestMethod` against `https://sonarcloud.io/api/measures/component`.

## Baseline (before cleanup pass 2)

Captured 2026-05-29, after PR #458 (Zoom PR-3) merged to `main` and this
branch was rebased onto `21aefdd9`. (Numbers differ slightly from the plan's
2026-05-29 pre-rebase snapshot — #458 added code so code_smells 386→393,
duplicated_blocks 80→81, ncloc 88127→88521.)

| metric | value |
|---|---|
| bugs | 3 |
| vulnerabilities | 0 |
| code_smells | 393 |
| security_hotspots | 18 |
| duplicated_lines_density | 1.4 |
| duplicated_blocks | 81 |
| duplicated_files | 54 |
| ncloc | 88521 |
| sqale_index | 2329 |
| sqale_rating | 1.0 (A) |
| reliability_rating | 4.0 (D) |
| security_rating | 1.0 (A) |
| coverage | 91.9 |

Raw JSON:

```json
[
  { "metric": "bugs", "value": "3", "bestValue": false },
  { "metric": "code_smells", "value": "393", "bestValue": false },
  { "metric": "coverage", "value": "91.9", "bestValue": false },
  { "metric": "duplicated_blocks", "value": "81", "bestValue": false },
  { "metric": "duplicated_files", "value": "54", "bestValue": false },
  { "metric": "duplicated_lines_density", "value": "1.4", "bestValue": false },
  { "metric": "ncloc", "value": "88521" },
  { "metric": "reliability_rating", "value": "4.0", "bestValue": false },
  { "metric": "security_hotspots", "value": "18", "bestValue": false },
  { "metric": "security_rating", "value": "1.0", "bestValue": true },
  { "metric": "sqale_index", "value": "2329", "bestValue": false },
  { "metric": "sqale_rating", "value": "1.0", "bestValue": true },
  { "metric": "vulnerabilities", "value": "0", "bestValue": true }
]
```

## After (cleanup pass 2) — expected deltas

SonarCloud only recomputes on a fresh CI analysis (the `sonar-scanner` step on
push/PR), so the authoritative after-numbers land on the dashboard once this
PR's analysis runs. The local proxy gates are all green. Expected deltas from
the work in this pass:

| metric | baseline | expected after | driver |
|---|---|---|---|
| bugs | 3 | 0 | WS-A — 3 `Array.sort` comparators (reliability D→A) |
| reliability_rating | 4.0 (D) | 1.0 (A) | WS-A |
| security_hotspots (TO_REVIEW) | 18 | 0 | WS-B — 8 code-hardened (auto-resolve) + 10 marked Reviewed→Safe |
| S3776 (cognitive complexity) | 55 TS + 2 C | 2 C only | WS-C C.1–C.6 (C.7 `main.c` BLOCKED — no toolchain) |
| code_smells | 393 | <100 | WS-C (−55) + WS-D mechanical sweep + WS-E |
| duplicated_lines_density | 1.4% | ≤1.4% | WS-E search-filter (26 connectors) + C.3 nimbus-toml validators |

Local enforced duplication gate (`jscpd --min-lines 10 --threshold 5`):
**3.08%** after vs **3.58%** at session start — improved (the search-filter +
nimbus-toml dedups outweigh the new extracted helpers). The stricter unenforced
`audit:duplication` (3% / min-lines 5) reads 4.7%, but it is not a CI gate.

Residual (not addressed, by design): the 2 C `c:S3776` + `c:S134`/`c:S125`/etc.
(toolchain-blocked), and a small set of deliberately-skipped TS smells
(`S3735`/`S107`/`S5843`/`S6551` + a few placeholder-test `S5914`) — see
`docs/superpowers/plans/2026-05-29-deferred-pass-5-lanes.md`.

## WS-B hotspot dispositions (18 reviewed)

Each of the 18 `TO_REVIEW` hotspots was read individually. None had exponential
(catastrophic) backtracking. Handling per the "code-harden where a real
improvement exists, mark Safe otherwise" decision:

**Code-hardened (8) — auto-resolve on next analysis (regex removed / absolute path):**

| Site | Was | Now |
|---|---|---|
| `connectors/obsidian-vault-id.ts:9` | `/[/\\]+$/` (anchored quantifier, O(n²)) | `stripTrailingChars` (O(n)) |
| `connectors/obsidian-daily-note.ts:70` | `/[/\\]+$/` | `stripTrailingChars` |
| `connectors/openapi-indexer-service-name.ts:20` | `/^-+\|-+$/g` | `stripAffixChars` |
| `extensions/registry-client.ts:23` | `/\/+$/` | `stripTrailingChars` |
| `extensions/registry-client.ts:128` | `/\/+$/` | `stripTrailingChars` |
| `mcp-connectors/obsidian/src/server.ts:87` | `/[/\\]+$/` | local `stripTrailingSlashes` |
| `mcp-connectors/obsidian/src/server.ts:354` | `/[/\\]+$/` | local `stripTrailingSlashes` |
| `platform/sandbox/darwin.ts:65` | `spawn("sandbox-exec", …)` (PATH) | `spawn("/usr/bin/sandbox-exec", …)` |

**Marked Reviewed → Safe in SonarCloud (10), with per-site justification:**

| Site | Justification |
|---|---|
| `src-native/sandbox-helper/main.c:92` | `strlen` on a NUL-terminated argv/env hostname; length re-checked ≤253 next line |
| `extensions/auto-update-init.ts:169` | `Math.random()` is poll-jitter only — no secret/token/nonce/key use |
| `connectors/intercom-conversation-mapping.ts:26` | `/<[^>]+>/g` negated class — linear, no backtracking |
| `connectors/stackoverflow-question-mapping.ts:29` | `/<[^>]+>/g` negated class — linear |
| `connectors/obsidian-parsing.ts:5` | `H1_RE` on the user's own local note body (trusted), bounded by line length |
| `connectors/obsidian-parsing.ts:6` | `WIKILINK_RE` lazy negated class — linear |
| `mcp-connectors/obsidian/src/server.ts:141` | `H1_RE` — trusted local note body |
| `connectors/_lib/pagination.ts:52` | Link-header regex — negated class + `\s*` bounded by required `rel` literal |
| `connectors/openapi-indexer-service-name.ts:31` | `/#.*$/` single greedy `.*` anchored at EOL — linear; trusted local TOML |
| `sdk/src/testing/sandbox-probe.ts:38` | http to non-routable TEST-NET-1 to assert egress is *blocked*; no data sent |

## Toolchain notes (Task 0.3)

- **No C compiler** (`gcc`/`clang`/`cl`) on the execution machine. Task C.7
  (`sandbox-helper/main.c` complexity refactor) and the C-side portion of WS-B
  Task B.2 (`main.c:92` strlen bound) are **BLOCKED** here — they cannot be
  compiled/verified locally. Deferred to a Linux/CI image with `gcc`. All
  TS workstreams (A, B-TS, C.1–C.6, D, E) are unaffected.

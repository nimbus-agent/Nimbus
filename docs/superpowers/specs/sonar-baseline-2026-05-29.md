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

## Toolchain notes (Task 0.3)

- **No C compiler** (`gcc`/`clang`/`cl`) on the execution machine. Task C.7
  (`sandbox-helper/main.c` complexity refactor) and the C-side portion of WS-B
  Task B.2 (`main.c:92` strlen bound) are **BLOCKED** here — they cannot be
  compiled/verified locally. Deferred to a Linux/CI image with `gcc`. All
  TS workstreams (A, B-TS, C.1–C.6, D, E) are unaffected.

# `scripts/cleanup/` — on-demand code-hygiene tools

One-off, developer-invoked analysis tools created for the **monorepo cleanup
pass** initiative (shipped 2026-05; the driving plan/spec docs have since been
removed — see `git log` under `docs/superpowers/` for the history).

These are **not** wired into `package.json`, the preflight gate manifest, or CI
— they are run by hand when doing a cleanup sweep. The four surveys write a
markdown report into `docs/superpowers/specs/punchlist/` (creating the directory
if absent) and print only a one-line summary; only `strip-comments.ts` rewrites
source files in place. Run each from the repo root:

```bash
bun scripts/cleanup/<script>.ts
```

| Script | What it does | Mutates files? |
|---|---|---|
| `survey-comments.ts` | Flags load-bearing vs. noise comments across `packages/` + `scripts/` | Writes `docs/superpowers/specs/punchlist/01-load-bearing-comments.md` |
| `survey-oc.ts` | Finds Open/Closed-principle violations via a TypeScript AST walk (`if`/`switch` over literal unions) | Writes `docs/superpowers/specs/punchlist/04-oc-violations.md` |
| `survey-srp.ts` | Flags Single-Responsibility offenders (oversized modules / mixed concerns) | Writes `docs/superpowers/specs/punchlist/03-srp-offenders.md` |
| `survey-shape-dupes.ts` | Finds structurally duplicated object/type shapes | Writes `docs/superpowers/specs/punchlist/02b-shape-dupes.md` |
| `strip-comments.ts` | Parser-aware (TS compiler API) comment stripper; supports `--dry-run` | **Yes — rewrites source in place** (run `--dry-run` first) |
| `lib.ts` | Shared `REPO_ROOT` + `iterateSourceFiles` + `relPath` helpers for the above | — |

`strip-comments.ts` is the only script here with a unit test
(`strip-comments.test.ts`, run via `bun run test:scripts`); it is the file to
diff first when reviewing a mechanical comment-strip commit.

`REPO_ROOT` in `lib.ts` resolves relative to the script file (not the
invocation cwd), so output is stable regardless of where you run from.

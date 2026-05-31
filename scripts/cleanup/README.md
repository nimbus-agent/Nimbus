# `scripts/cleanup/` — on-demand code-hygiene tools

One-off, developer-invoked analysis tools created for the **monorepo cleanup
pass** initiative (see
[`docs/superpowers/plans/2026-05-28-monorepo-cleanup-pass.md`](../../docs/superpowers/plans/2026-05-28-monorepo-cleanup-pass.md)).

These are **not** wired into `package.json`, the preflight gate manifest, or CI
— they are run by hand when doing a cleanup sweep, and most print a report to
stdout rather than mutating files. Run each from the repo root:

```bash
bun scripts/cleanup/<script>.ts
```

| Script | What it does | Mutates files? |
|---|---|---|
| `survey-comments.ts` | Flags load-bearing vs. noise comments across `packages/` + `scripts/` | No (report) |
| `survey-oc.ts` | Finds Open/Closed-principle violations via a TypeScript AST walk (`if`/`switch` over literal unions) | No (report) |
| `survey-srp.ts` | Flags Single-Responsibility offenders (oversized modules / mixed concerns) | No (report) |
| `survey-shape-dupes.ts` | Finds structurally duplicated object/type shapes | No (report) |
| `strip-comments.ts` | Parser-aware (TS compiler API) comment stripper; supports `--dry-run` | **Yes** (run `--dry-run` first) |
| `lib.ts` | Shared `REPO_ROOT` + `iterateSourceFiles` + `relPath` helpers for the above | — |

`strip-comments.ts` is the only script here with a unit test
(`strip-comments.test.ts`, run via `bun run test:scripts`); it is the file to
diff first when reviewing a mechanical comment-strip commit.

`REPO_ROOT` in `lib.ts` resolves relative to the script file (not the
invocation cwd), so output is stable regardless of where you run from.

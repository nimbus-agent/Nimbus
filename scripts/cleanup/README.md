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
| `strip-comments.ts` | Parser-aware (TS compiler API) comment stripper. Refuses protected files (see below); a bare invocation rewrites NOTHING - pass `--dry-run` to report, or `--paths=<a,b>` to scope it | **Yes, but only for paths you name** |
| `protected-comments.ts` | The one definition of "load-bearing", shared by `survey-comments.ts` and `strip-comments.ts` so they cannot disagree | — |
| `lib.ts` | Shared `REPO_ROOT` + `iterateSourceFiles` + `relPath` helpers for the above | — |

`strip-comments.ts` and `protected-comments.ts` are the scripts here with unit
tests (`strip-comments.test.ts`, `protected-comments.test.ts`, run via
`bun run test:scripts`); they are the files to diff first when reviewing a
mechanical comment-strip commit.

## Why stripping is opt-in

Comments in this repo are frequently data rather than prose, and two bodies of
work read them as such: `docs/SECURITY-INVARIANTS.md` carries an audited
inventory citing comments at `file.ts:LINE` (152 rows across 77 files), and
comments carrying an invariant id, HITL note, ticket reference or security
caveat are the rationale that makes those defenses auditable. `PRESERVE_PRAGMAS`
covers neither - it protects machine-read directives, a different question.

`protected-comments.ts` refuses both groups - around 550 files today; run
`--dry-run` for the live figure rather than trusting this sentence. It fails
closed if the invariant doc cannot be parsed, since an empty protected set looks
exactly like "nothing here is attested".

That guard is a floor, not a licence. It matches twelve markers, and this repo's
load-bearing comments outrun them: the largest single strip candidate,
`agents/negotiate.ts`, would lose 25KB explaining why a `graph-only` subject is
structurally zero for every lane except ownership - reasoning no marker matches
and the code cannot restate. So a run must name its paths, having read them.

`REPO_ROOT` in `lib.ts` resolves relative to the script file (not the
invocation cwd), so output is stable regardless of where you run from.

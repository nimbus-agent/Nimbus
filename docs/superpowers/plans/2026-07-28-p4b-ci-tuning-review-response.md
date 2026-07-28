# P4b tuning plan review — response

Response to [`2026-07-28-p4b-ci-tuning-review.md`](./2026-07-28-p4b-ci-tuning-review.md).

**All four findings are valid, and two of them found real bugs in the plan.**
Finding 2 is the significant one: it exposed a misclassification in the design's
own PAL sweep, which would have shipped a coverage gate to Linux-only while the
code it covers branches on platform — precisely the failure the audit exists to
prevent.

| # | Finding | Outcome |
| --- | --- | --- |
| 1 | Detector skips nested `packages/mcp-connectors/*/src` | **Fixed** — confirmed 94 skipped directories |
| 2 | Detection regex misses destructured `platform` imports | **Fixed** — and it caught a wrong `pal: false` on the `Doctor` gate |
| 3 | Line-based YAML parser is indentation-brittle | **Partly fixed** — the premise needs one correction: it already fails loud, not silent |
| 4 | Probe API error handling | **Fixed**, and the real hazard is worse than described |
| Q | How is `packages/ui` handled? | **Answered from measurement** |

---

## 1. Nested packages — fixed

The finding is right and the consequence is exact. `detectPlatformBranchingFiles`
iterated `readdirSync(packages)` and looked for `<pkg>/src`, so for
`packages/mcp-connectors` it looked for `packages/mcp-connectors/src`.

Measured: that path **does not exist**, and there are **94** nested
`packages/mcp-connectors/*/src` directories. Every one was skipped.

No connector branches on platform today, which is why this would have gone
unnoticed — and is exactly why it matters. A detector with a silent blind spot
is worse than no detector, because the green result is read as coverage.

**Fixed** by discovering `src` directories at any depth rather than assuming
they sit one level down. The "only `src`, never `test`" principle is preserved:
scanning everything under `packages/` would flag the cross-platform test helpers
that branch on `process.platform` legitimately, which is the false-positive noise
the design set out to avoid.

---

## 2. Detection regex — fixed, and it found a real misclassification

The finding proposes the regex may miss destructured imports. It does not "may":
**it does, and the pattern is in active use.**

```text
packages/cli/src/commands/doctor-core.ts        import { platform } from "node:os"
packages/gateway/src/ipc/server/server.ts       import { platform } from "node:os"
packages/gateway/src/platform/gateway-log-file.ts
packages/gateway/src/platform/index.ts
packages/gateway/src/platform/sandbox/sandbox-runner.ts
packages/gateway/src/vault/factory.ts
```

Those are the six the sweep had not already classified; the full count of files
using the idiom is **seven**, the seventh being `packages/gateway/src/perf/bench-cli.ts`,
which was already covered by the `Perf` gate and so surfaced nothing new.

All six branch on the result — `if (platform() === "linux")`,
`if (platform() === "win32")`, `const p = platform()`. The original regex
`/process\.platform|os\.platform\(\)/` matches none of them.

### The consequence: the design's own sweep was wrong

`packages/cli/src/commands/doctor-core.ts:80` reads:

```ts
if (platform() === "linux") {
```

The `Doctor` coverage gate (`test:coverage:doctor` →
`packages/cli/src/commands/doctor*.test.ts`) covers that file, and the design
classified `Doctor` as **`pal: false`** — Linux-only. Shipping that would have
stopped watching the non-Linux branches of the very file that reports
platform health, while the audit reported OK.

This is the failure mode Change C was written to prevent, found in the
classification that Change C was written from. The static sweep in the design is
correspondingly **less trustworthy than it claimed**, and the design's own
caveat — that this is static, not empirical, evidence — earned its keep.

**Fixed:**

- Detection now also matches an `import { … platform … } from "node:os"`
  (including `platform as alias`) and `os.type()`.
- `Doctor` moves to **`pal: true`**.
- The five other files are added to the allowlist: `vault/factory.ts` → `Vault`
  and `sandbox/sandbox-runner.ts` → `Sandbox` are already `pal: true`;
  `platform/index.ts`, `platform/gateway-log-file.ts` and `ipc/server/server.ts`
  are `gate: "none"`.

`ipc/server/server.ts` was checked rather than assumed: the `LAN` gate's test set
imports `lan-server.ts` only, never `ipc/server/server.ts`, so no
threshold gate covers it.

### Revised numbers

Seven PAL gates, not six:

| | before | after |
| --- | --- | --- |
| coverage-gate jobs | 72 | **38** (was 36) |
| jobs per push run | 105 | **71** (was 69) |

The plan and design are corrected to these figures. Two extra jobs is the
correct price for not silently dropping a platform branch.

---

## 3. YAML parser resilience — partly fixed, with a correction

The concern is reasonable, but the premise needs one correction: the parser
**cannot fail silently**. Two guards already make a parse failure loud:

- `gates.length === 0` returns the hard error
  `no coverage-gates matrix entries found`.
- A `name:` that parses while its `pal:` does not yields `pal: null`, which rule
  4 reports as `has no explicit pal: field`.

So a reformat that breaks the parser reddens the gate; it does not quietly pass.
The real cost is a **false red on a cosmetic change**, which is still worth
avoiding.

**Fixed** by matching on relative structure instead of absolute column counts:
the matrix block ends at the first line whose indentation is less than or equal
to the `gate:` key's own, entries are recognised by `- name:` at deeper
indentation, and `pal:` by a deeper-still sibling. A test with a different
indentation width is added, per the finding's suggestion.

---

## 4. Probe error handling — fixed, and the hazard is worse than described

The top-level path was already handled: an unauthenticated `gh` yields zero runs
and both probes exit 1 with
`no successful push runs readable — is 'gh' authenticated?`.

The real gap is one level down, and it is more dangerous than a missing message.
`jobsForRun` breaks out of its paging loop when a page read fails, returning
whatever it had. **Job count is this slice's headline metric.** A silent
truncation during the *after* measurement would report fewer jobs than really
ran and be read as proof the change worked. A measurement instrument that fails
toward its own hypothesis is worse than none.

This is the same hazard the measurement slice handles with
`MAX_READ_FAILURE_RATIO`, and it gets the same treatment: page reads are
counted, and a probe that suffered any read failure prints
`::warning::` naming the count and refuses to print a job-count summary for the
affected run rather than printing a low number without comment.

---

## Q. `packages/ui`

Measured: **no file under `packages/ui` branches on platform today** (checked
for `process.platform`, `os.platform()`, `os.type()` and destructured `node:os`
imports across `.ts` and `.tsx`).

The detector already includes `.tsx` and, with finding 1's fix, reaches
`packages/ui/src`. No UI coverage gate exists in the `_test-suite.yml` matrix, so
a future platform-branching UI file would be classified `gate: "none"` — recorded
as considered, not protected. If a UI coverage gate is ever added, rule 4 forces
it to be classified `pal` explicitly at that moment.

---

## Net changes to the plan

- **Task 1** — `detectPlatformBranchingFiles` discovers `src` at any depth;
  detection covers destructured `node:os` imports and `os.type()`;
  `parseCoverageGateMatrix` uses relative indentation; six new allowlist entries;
  new tests for nested discovery, destructured-import detection, and indent
  variation.
- **Task 2** — `Doctor` becomes `pal: true`; seven PAL gates, seventeen
  Linux-only; verification step expects `total 24 / pal 7 / unclassified 0`.
- **Task 5** — probes count read failures and refuse to report a truncated job
  count.
- **Task 6** — the recorded figures become 72 → 38 coverage jobs and 105 → 71
  per run.

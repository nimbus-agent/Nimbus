# Plan Review Response: Zero-config onboarding

Response to
[2026-07-27-zero-config-onboarding-review.md](./2026-07-27-zero-config-onboarding-review.md).
Each item was checked against the codebase before being accepted. One is
rejected on empirical evidence, and one cites files that do not exist.

| # | Item | Outcome |
| --- | --- | --- |
| 1 | Table-awareness in `hasFilesystemRoot` | **Accepted** |
| 2 | Windows escaping mismatch | **Rejected — verified not a bug**, concern pinned by a test |
| 3 | Choose option (a) for the picker | **Deferred** — decision is the owner's; cited paths corrected |
| 4 | Subprocess timeout in e2e | **Accepted** |

---

## 1. Table-awareness — accepted

Correct. `hasFilesystemRoot` matched any `path = …` line anywhere in the file,
so a `path` key under an unrelated table would make `init` report
"already configured" and **silently never add the root** — a quiet failure of the
feature's whole purpose.

Verified it is latent rather than live: `filesystem-toml.ts:84` is the only
`case "path"` among the config parsers, so nothing in Nimbus writes a competing
`path` key today. A user or a future section still can.

Adopted the state machine. Five lines to be correct by construction instead of
correct by coincidence, plus a test asserting a `path` under
`[some_other_section]` is ignored.

## 2. Windows escaping — rejected, and the reasoning is worth recording

The claim: `appendFilesystemRoot` writes `JSON.stringify(target)`, so on Windows
the file gets `path = "C:\\gitrep\\Nimbus"`; `hasFilesystemRoot` slices the quotes
off and gets doubled backslashes; the comparison mismatches and duplicate blocks
accumulate.

The escaping analysis is right. The conclusion is not. **`expandPath` calls
`resolve()`, and `resolve()` normalises duplicate separators on Windows**, so
both sides converge. Verified by executing the exact round-trip:

```text
target          : "C:\\gitrep\\Nimbus"
file text       : path = "C:\\gitrep\\Nimbus"
gateway reads   : "C:\\\\gitrep\\\\Nimbus"     ← doubled, as the review predicted
gateway resolve : "C:\\gitrep\\Nimbus"
target resolve  : "C:\\gitrep\\Nimbus"
ROUND-TRIP OK?  : true
```

`hasFilesystemRoot` resolves both sides too, so the same normalisation applies
there. No mismatch, no duplicate blocks.

Worth stating what the review *did* surface, because it is real and was not in
the plan: the gateway's `parseString` (`filesystem-toml.ts:39-45`) un-escapes
only `\"` — **not** `\\`. The write/read round-trip therefore works by an
incidental property of `resolve()` rather than by symmetric escaping. That is
fragile knowledge to leave implicit, so it is now:

- pinned by a test that round-trips a Windows-style path through
  `appendFilesystemRoot` → `hasFilesystemRoot` and asserts the second call
  reports `already-present`; and
- called out in a comment at the `resolve()` site explaining that it is
  load-bearing, not cosmetic.

Changing the write format to forward slashes would also round-trip (verified),
but swapping a working format on the strength of a non-bug adds risk without
buying correctness. The test is the better answer.

## 3. Pick option (a) — deferred, and two cited paths do not exist

**The paths are wrong.** There is no `packages/gateway/src/ipc/schema.ts` and no
`packages/gateway/src/ipc/handlers/why.ts`. The IPC layer is organised as
`packages/gateway/src/ipc/*-rpc.ts` plus `ipc/server/dispatchers.ts`. Following
the recommendation literally would create a parallel structure that does not
match the codebase — the same failure mode as the design review's
`NIMBUS_CONFIG_DIR`, which also did not exist. The plan now says so explicitly
and points at the `nimbus-ipc` skill instead.

**The choice itself stays open.** The plan deliberately frames (a) vs (b) as a
decision because (a) is real added surface — a method, a runtime validator, a
Tauri-allowlist call under `I7`, and docs — bought for a modest gain: a specific
`file:line` versus a generic one. That trade belongs to whoever owns the launch
scope, not to the plan. What the plan does enforce is that the decision is made
explicitly and that `init` never promises a `file:line` it cannot produce.

One addition adopted from the review regardless of which option wins: if (a) is
chosen, `init` must degrade to the generic next step when the daemon is not
running, rather than erroring.

## 4. Subprocess timeout — accepted

Correct, and cheap. `await proc.exited` with no bound means a CLI that blocks on
an unexpected prompt hangs the entire CI job rather than failing. "The runner
never finished" is materially harder to diagnose than an explicit timeout.

Added a 15s hard kill (not 5s — first-run indexing on a cold cache can legitimately
exceed 5s, and a too-tight bound would trade a hang for a flake).

# Design Review Response: Zero-config onboarding

Response to
[2026-07-27-zero-config-onboarding-design-review.md](./2026-07-27-zero-config-onboarding-design-review.md).
Each item was checked against the codebase before being accepted; two of the
review's assumptions turned out to be wrong, and one issue is more serious than
the review knew.

| # | Item | Outcome |
| --- | --- | --- |
| 1 | Safe TOML merging | **Accepted, escalated** — append-only |
| 2 | Demo file selection | **Accepted, simplified** — index-driven, not filesystem heuristics |
| 3 | Sync latency / background indexing | **Deferred** — measure first; one constraint adopted now |
| 4 | Daemon boot + graceful failure | **Accepted, corrected** — reuse existing error convention |
| 5 | E2E isolation | **Requirement accepted, mechanism rejected** — `NIMBUS_CONFIG_DIR` does not exist |

---

## 1. Safe TOML merging — accepted, and worse than described

The review asks how merging avoids stripping comments and reordering keys.
Verified, and the situation is sharper than the question assumes:

- **Nothing writes `nimbus.toml` today.** `filesystem-toml.ts`,
  `nimbus-toml-connectors.ts`, and `nimbus-toml-workday.ts` all read it; there
  are no write paths in production code. `nimbus init` would be the first.
- **There is no serializer to round-trip through.** Parsing is a bespoke section
  scanner (`forEachSectionEntry`, `parseNimbusTomlFilesystemRoots`), not a TOML
  library. The "parse to object, stringify" failure mode the review describes is
  not even available to us without adding a dependency.

So the mitigation the review proposes (a comment-preserving parser) would mean
adding a runtime TOML dependency on the critical path for a single append.

**Decision: append-only, never rewrite.** Append a `[[filesystem.roots]]` block
to the end of the file, or create it. Appending cannot reorder keys, strip
comments, or reformat anything — it removes the corruption class structurally
instead of mitigating it. Idempotency comes from reading first:
`parseNimbusTomlFilesystemRoots` already returns existing roots, so `init`
no-ops when the path is present.

The `nimbus.toml.bak` suggestion is **adopted** — cheap insurance, even though
append-only makes loss unlikely.

## 2. Demo file selection — accepted, simplified

The concern is real: an arbitrary pick could land on `package-lock.json` or a
binary asset and produce a dull or broken first impression.

The proposed remedy — `git ls-files`, filter lockfiles/configs/markdown/large
files, a per-language extension priority list, then scan for the first
"non-trivial" line — is more machinery than the problem needs, and each heuristic
is a thing to maintain and get wrong.

**Decision: select from the index, not the filesystem.** `nimbus why` resolves a
*symbol in the index*, so the index is the authoritative source for "something
that will definitely produce a good answer." After sync, query it for an indexed
code symbol and print that location.

This is strictly more robust: it cannot pick a lockfile or a binary (those never
become code symbols), it needs no extension allowlist, and it requires no
"non-trivial line" heuristic because a symbol *is* the interesting line. It also
satisfies item 3's "point at an already-indexed file" constraint for free.

## 3. Sync latency — deferred, with one constraint adopted now

The mechanism proposed (threshold at ~500 files / 50 MB, `git log --name-only
-n 20` to find hot files, index those synchronously, rest in background) is
sound. It is also premature: **it is not yet established that sync is slow.**

Building prioritised-then-background indexing before measuring is precisely the
"rebuild onboarding before knowing where users actually drop" trap this spec
lists in its out-of-scope section. Doing it here would contradict the spec's own
reasoning.

**Decision: measure first.** Time the first sync on a large repo during
implementation; build prioritisation only if the number is bad. The open
question in the spec is updated to say so explicitly rather than leaving it
implicitly open.

**One part adopted immediately:** the printed next command must point at
something already indexed. That is a correctness constraint regardless of whether
prioritisation is ever built — and it falls out of item 2's index-driven
selection anyway.

## 4. Daemon boot and graceful failure — accepted, one correction

**Boot without `[llm]`:** the audit is the right ask. Partial evidence already
exists — config parsing reads the section via
`forEachSectionEntry(source, "[llm]", …)`, a scanner, so an absent `[llm]` is
simply never visited. That is strong but not proof for process startup. Accepted:
the §4 e2e test plus an explicit config unit test for the empty-config lifecycle.

**Structured error:** accepted in intent, corrected in form. The review proposes a
string code (`LLM_NOT_CONFIGURED`). The IPC layer already has an error-code
convention — JSON-RPC numeric codes (`-32602` and friends) used throughout the
RPC handlers. Introducing a parallel string-enum scheme for one case would be
drift. The gateway returns a distinguishable error in the existing convention and
the CLI renders the setup guidance.

## 5. E2E isolation — requirement accepted, mechanism rejected

The rule is right and treated as non-negotiable: the test must never touch the
developer's real config directory or the OS keychain.

The proposed mechanism does not exist. **There is no `NIMBUS_CONFIG_DIR`.**
`platform/paths.ts` derives `configDir` from `%APPDATA%` on Windows and
`XDG_CONFIG_HOME` / `~/.config` elsewhere; no override env var is read anywhere
in production code. Writing the test against that name would fail, or worse,
silently fall through to the real config directory — the exact outcome the review
is trying to prevent.

**Decision:** keep the constraint, source the mechanism from what exists —
overriding the platform env vars, injecting `PlatformServices` (the documented
PAL seam), or adding a genuine config-dir override. Adding one is itself a small
piece of work the implementation plan must budget for rather than assume.

The vault half of the suggestion is already solved: `vault/mock.ts` is the
established in-memory adapter used by existing suites.

Worth noting for completeness: the repo-wide `[test] preload`
(`scripts/test-preload/hermetic-credentials.ts`) blanks credential env vars
before any test module loads, so an inherited provider key cannot silently
satisfy the "no LLM" precondition.

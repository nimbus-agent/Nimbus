# Zero-config onboarding — design

**Date:** 2026-07-27
**Status:** approved, pending implementation plan
**Goal:** make the first valuable moment reachable with no credentials, no API key, and no config editing — so a relaunch converts instead of bouncing.

---

## Why

Nimbus is public, at `v1.1.0`, with signed multi-platform binaries, a live docs
site, published npm packages, and an 87% community health score. It has **3
stars and 0 forks**. It has been posted to Reddit and to Twitter/LinkedIn and got
no traction.

Two independent causes. Only one is about marketing.

### Venue

Reddit devops communities are hostile to self-promotion and heavily mod-removed;
social has no distribution without an existing following. The two venues suited
to this product were never tried:

- **Show HN** — local-first, AGPL, signed builds, "nothing leaves your machine"
  is precisely Hacker News's taste.
- **The MCP community** — Nimbus ships 80+ first-party MCP connectors into an
  ecosystem that is actively short of them.

### Funnel

This is the larger problem. Counting from install to first value on `main` today:

1. install the binary — fine
2. leave the terminal, create a GitHub PAT, choose scopes
3. `nimbus connector sync github`, wait an unbounded time
4. **provide an LLM** — paste a paid API key, or install Ollama and pull a ~5 GB model
5. `nimbus ask "…"`

Four gates before anything of value, one of which costs money or 5 GB of disk.
`nimbus why` — the strongest demo, and the one the README leads with — needs an
additional hand-edit of `nimbus.toml` (`[[filesystem.roots]]` +
`code_index = true`) and another sync.

There is no demo mode, no sample index, and no zero-config path exposed.

This matters because a project gets roughly one good Show HN. A front-page post
sends 10–30k developers within hours; with this funnel most bounce at step 4, and
the launch cannot be re-run.

### The finding that shapes the fix

**The zero-config path already exists in the code — it is unexposed and
contradicted by the docs.**

`agents/_lib/synthesize.ts:81`:

```ts
export async function synthesize(brief: SynthInput, opts: SynthesizeOpts = {}): Promise<string> {
  const deterministic = deterministicRender(brief);
  if (opts.llm === undefined) return deterministic;
  …
```

The LLM is optional, and only "rewrites the deterministic Markdown into a more
readable brief." Even when one is configured, a `null`, empty, or throwing
response falls back to the deterministic render (lines 96–99). Optionality holds
end-to-end: `agents/why.ts:24` declares `llm?: SynthesizerLlm`, and the RPC layer
spreads it conditionally (`...(ctx.llm === undefined ? {} : { llm: ctx.llm })`),
so an unconfigured LLM propagates as `undefined` rather than raising.

Filesystem indexing needs no credentials. So `nimbus why` on a repo the user
already has requires **no PAT, no API key, and no network** — today. Nothing
surfaces that, and the README's "Nimbus needs an LLM" states the opposite.

This is therefore mostly a packaging problem, not a build.

---

## Design

### 1. `nimbus init` — the zero-gate on-ramp

A new CLI command that makes the existing path reachable in one step.

- Detects that the cwd is a git repository.
- Merges a `[[filesystem.roots]]` entry for it into `nimbus.toml`, with
  `code_index = true`.
- Runs the first sync with visible progress.
- Prints the exact next command using a real `file:line` drawn from *their*
  repository, not a placeholder.

Constraints:

- **Idempotent.** Re-running is safe.
- **Never clobbers.** A user's existing roots, connectors, and LLM settings
  survive, along with their comments and formatting.
- **No credentials, no LLM, no network.**

#### Append-only, never rewrite

`nimbus init` would be the **first production code that writes `nimbus.toml`** —
verified: `filesystem-toml.ts`, `nimbus-toml-connectors.ts`, and
`nimbus-toml-workday.ts` all read the file and nothing writes it. The parser is
also a bespoke section scanner (`forEachSectionEntry`,
`parseNimbusTomlFilesystemRoots`), not a round-trippable TOML library, so there
is no serializer to write back through.

That rules the usual approach out and points at a safer one:

- **Append a `[[filesystem.roots]]` block to the end of the file**, or create the
  file if absent. Appending cannot reorder keys, cannot strip comments, and
  cannot reformat anything the user wrote — it structurally avoids the whole
  corruption class rather than mitigating it.
- **Read before appending.** `parseNimbusTomlFilesystemRoots` already returns the
  existing roots, so `init` checks for the target path and no-ops if present.
  That is where idempotency comes from.
- **Back up to `nimbus.toml.bak` before the write.** Cheap insurance even though
  append-only makes loss unlikely.

Explicitly **not** adding a TOML serializer dependency for this. It would be a
new runtime dependency on the critical path for a single append.

#### Choosing the `file:line` to print

Not a filesystem heuristic. `nimbus why` resolves a **symbol in the index**, so
picking a file by extension or size can still land on something unindexed or
uninteresting. Instead, after sync, query the index for an indexed code symbol
and print that location.

This is guaranteed to resolve, needs no per-language extension allowlist, and
cannot pick a lockfile or a binary asset — those never become code symbols. It
also inherently satisfies the "point at something already indexed" requirement
that background indexing (below) would otherwise impose.

### 2. Make "no LLM" a stated mode

The capability exists but reads as breakage. When no LLM is configured, agents
render deterministically and print one line:

> Rendered deterministically — configure an LLM for prose synthesis.

So it is legible as a deliberate mode rather than something degraded.

Separately, `nimbus ask` genuinely requires an LLM. It should fail with a helpful
message naming both routes (local Ollama, or a provider key) — not a stack trace.
The gateway returns a distinguishable error and the CLI renders the guidance;
the error uses the **existing JSON-RPC numeric-code convention** already in use
across the IPC layer, rather than introducing a parallel string-enum scheme.

### 3. README rewrite

- Step 1 becomes `nimbus init` in a repo the reader already has, then
  `nimbus why`.
- The LLM moves to an optional upgrade section, framed around `nimbus ask` and
  prose synthesis.
- **Cut "Nimbus needs an LLM."** It is the most damaging sentence in the funnel
  and it is not true of the demo the README leads with.

### 4. An e2e test that is the funnel

Fresh temp config dir, no credentials, no LLM configured → `nimbus init` in a
fixture git repo → `nimbus why <file>:<line>` returns non-empty output and exits
0.

This test is the guarantee that the launch demo works on a stranger's machine,
and it fails loudly if anyone reintroduces a gate. It also settles an open
question below.

**Isolation is a hard requirement:** the test must never read or write the
developer's real config directory or the OS keychain (DPAPI / Keychain /
libsecret). Two notes on mechanism, both verified:

- There is **no `NIMBUS_CONFIG_DIR` override today.** `platform/paths.ts` derives
  `configDir` from `%APPDATA%` on Windows and `XDG_CONFIG_HOME` / `~/.config`
  elsewhere. Isolation therefore comes from overriding those, from injecting
  `PlatformServices` (the documented PAL seam), or from adding a real config-dir
  override — and adding one is itself a small piece of work this plan must
  account for rather than assume.
- The vault seam already exists: `vault/mock.ts` is the established in-memory
  adapter used by existing suites.

The repo-wide `[test] preload` (`scripts/test-preload/hermetic-credentials.ts`)
already blanks credential env vars before any test module loads, so an inherited
provider key cannot silently satisfy the "no LLM" precondition.

### 5. Measurement — deliberately non-invasive

Release-asset download counts per release, star/fork velocity, and docs-site
analytics.

**No telemetry.** Adding phone-home to a tool whose entire pitch is "nothing
leaves your box" would cost more credibility than the data is worth, and on
Hacker News it would be the top comment. This is a deliberate constraint, not an
oversight.

---

## Open questions

Both are answered by implementation rather than discussion:

1. **Does the gateway daemon boot cleanly with no `[llm]` block at all?** The
   agent path is verified, and config parsing reads `[llm]` through
   `forEachSectionEntry(source, "[llm]", …)` — a section scanner, so an absent
   section is simply never visited. That is strong evidence but not proof for
   process startup. The §4 e2e test settles it, plus a config unit test for the
   empty-config lifecycle.
2. **Is first sync on a large repo fast enough to feel instant?** Deliberately
   left to measurement rather than pre-solved. A prioritise-then-background
   scheme (index recently-changed files first, continue the rest in the
   background) is the obvious fix *if* it is needed, but building it before
   measuring is the same "rebuild onboarding before knowing where users drop"
   trap this spec exists to avoid. Measure first; build only on evidence.

   One constraint applies regardless of the outcome: the printed next command
   must point at something already indexed. That falls out of selecting the
   `file:line` from the index (§1) rather than from the filesystem.

---

## Out of scope

Deliberately excluded, to keep this shippable in days rather than weeks:

- **A sample/demo index** (`nimbus demo`). Converts well on HN, but it is fake
  data — skeptics discount it, and canned output must never be mistakable for a
  live LLM answer. Revisit if bounce data calls for it.
- **An interactive setup wizard, Ollama auto-bootstrap, connector picker.**
  Rebuilding onboarding before knowing where users actually drop is the classic
  trap; §1 unblocks the same path for a fraction of the cost.
- **winget submission**, `good first issue` seeding, and the relaunch posts
  themselves. All real, all tracked separately — none of them belong inside this
  change.

---

## Sequencing

Ship §1–§4, then relaunch on Show HN and in the MCP community, with the
asciinema cast recut to the zero-config path. Hold the out-of-scope items until
the bounce data says they are needed.

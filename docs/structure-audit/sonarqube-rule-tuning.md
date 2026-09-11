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

### PR 6 — S4325 inline `// NOSONAR` (Sonar-vs-`tsc` divergence)

S4325 ("unnecessary cast — does not change the type") had 622 sites. The vast
majority were genuinely redundant and were **removed in code** (no suppression).
A small set were Sonar **false positives**: removing the cast makes `tsc` fail,
because Sonar's type model lacks the strict-mode features our `tsconfig` enables
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), full third-party lib
types, or Bun's mock types. For these — and only these — the cast is restored
with an inline `// NOSONAR S4325: <reason>`. `tsc` is the oracle: each NOSONAR
marks a line that does **not** compile without the cast.

| Site | Cast | Why `tsc` needs it |
|---|---|---|
| `gateway/src/connectors/_lib/imap-client.test.ts` | `partial as MessageStructureObject` | `Partial<T>`→`T` under `exactOptionalPropertyTypes` |
| `gateway/src/connectors/pagerduty-sync.test.ts` (×4) | `x as string` | `string \| undefined` (captured var / `noUncheckedIndexedAccess` index) |
| `gateway/src/ipc/agents-rpc.test.ts` (×4) | `ctx.notify as ReturnType<typeof mock>` | exposes the Bun mock's `.mock.calls` |
| `gateway/src/ipc/server/vault-dispatch.test.ts` (×2) | `db as never` | minimal `{close}` stub widened to `Database` |
| `gateway/src/people/linker.test.ts` | `idA as string` | `idA` is `string \| null`; `toBe` expects `string` |
| `gateway/src/embedding/load-feature-extraction-pipeline.ts` | `as unknown as FeatureExtractionPipe` | bridges `@xenova` `FeatureExtractionPipeline` to the local interface |
| `gateway/src/perf/process-spawn-bench.ts` | `as unknown as ProcSubset` | bridges Bun `Subprocess` (`stdout?`) to `ProcSubset` |

### PR 7 — `shelldre:S7682` inline `# NOSONAR` (never-returning fatal handler)

The `shelldre:*` shell-analyzer sweep (14 issues across 5 scripts) was fixed in
code: `[` → `[[` for the bash files (`S7688`), nested-`if` merges (`S1066`), and
a positional-param-to-local assignment (`S7679`). One issue is a genuine false
positive and is suppressed inline.

| Site | Rule | Why it's suppressed |
|---|---|---|
| `.claude/hooks/bash-safety.sh` `block()` | `shelldre:S7682` | The function is a fatal handler that always terminates the hook via `exit 2`; an explicit `return` at the end would be unreachable, and rewriting it as return-then-exit at the four call sites would risk the hook's blocking guarantee. |

### PR 7 — `typescript` S77xx tail inline `// NOSONAR` (semantics-preserving exceptions)

The S77xx modernization tail was fixed in code (`String.fromCodePoint`,
`replaceAll`, `.at(-1)`, `Number.parseInt`, `globalThis`, `TypeError`, etc.).
Two sites cannot adopt the suggested rewrite without changing behavior or
breaking compilation, so the original is kept with an inline `// NOSONAR`.

| Site | Rule | Why it's suppressed |
|---|---|---|
| `great-expectations/src/gx-parse.ts` `clampId()` (now in nimbus-mcp-servers) | `typescript:S7767` | `(… ) \| 0` is a deliberate 32-bit wraparound (Java-style `hashCode`), not a truncation; `Math.trunc` would let the accumulator exceed 2^53 and corrupt the hash. |
| `sdk/src/testing/sandbox-probe.ts` | `typescript:S7787` | The specifier-less `export {}` is the module marker required by the top-level `await main()` below it; removing it makes the top-level await a compile error (TS1375). |

## 2026-09-11 — the SDK signing-surface deprecation, and one native-helper vulnerability

### `typescript:S1874` — three seam files, ~12 markers

`@nimbus-dev/sdk` 1.32.0 deprecated its whole flat manifest-signature surface in favour of a
detached-JWS envelope under `@nimbus-dev/sdk/signing`. **That envelope has not shipped** — the
subpath exports canonicalization and nothing else — so the warnings are real (removal is slated for
SDK 2.0.0) and there is nothing to migrate to, while the gateway must keep verifying the flat shape
every already-installed extension carries.

**Most of the cluster was FIXED rather than suppressed**, by splitting on what each symbol actually
is. The base64 codec, Ed25519 keygen and the `SignatureDisableReason` union are not part of the
envelope being replaced, so the gateway and CLI own them outright now
(`gateway/src/util/{base64,ed25519}.ts`, `cli/src/lib/extension-signing.ts`) — 80 of the 98
findings. What remains is only the contract itself, confined to one seam file per package:

| Site | Rule | Why it's suppressed |
|---|---|---|
| `gateway/src/extensions/verify-signature.ts` | `typescript:S1874` | `signManifest` / `verifyManifestSignature` / `errorToHardDisableReason` ARE the contract: a connector author signs with the SDK and the gateway must verify what they produced, so a local reimplementation would be a second, drifting copy on a signature-critical path. Wrapped rather than re-exported, so the deprecation stops at this file — a consumer importing a RE-EXPORTED deprecated symbol is still flagged, which is why the pre-existing re-export shed nothing. |
| `gateway/src/extensions/canonical-json.ts` | `typescript:S1874` | Here the replacement EXISTS and produces **different bytes**: the deprecated rules NFC-normalize string VALUES, the spec binding deliberately does not (Go publishes no importable normalization). Those bytes are load-bearing for every installed extension signature (`I16`) and every saved-tool signature (`I40`) already on disk, so migrating is a re-signing exercise, not an import swap. |
| `cli/src/lib/extension-signing.ts` | `typescript:S1874` | The CLI's own copy of the seam — `packages/cli` may not import gateway source. Keygen and base64 are owned here; only `signManifest` is the SDK's, for the reason above. |

Each marker is a **trailing** comment on the reported line (a marker in a block above the statement
is silently ignored). **Retire all three when the JWS envelope ships**: the migration is then a
three-file change plus a re-sign, and these rows should be deleted, not amended.

### `c:S5849` — `sandbox-helper/main.c` `drop_all_caps()`

Marked **Accepted** on the SonarCloud board rather than suppressed in code (it is C, and the rule is
reported as a VULNERABILITY). The flagged `cap_set_proc()` installs an EMPTY capability set
immediately before `execv`, so it _drops_ every capability rather than acquiring one — the rule
fires on any `cap_set_proc` regardless of direction. There is no code change that clears it without
removing the hardening. Issue key `AaCHEeXpGOMqvmq55deI`.

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

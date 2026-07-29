# First-run reliability — the two open decisions in #925 and #928

> **Status:** design memo, 2026-07-29. Decides only the two questions the issues
> leave explicitly undecided. Bind-first (#928's first bullet) is being
> implemented separately and is assumed done throughout. The undiagnosed macOS
> "gateway alive, socket never bound" failure is a **separate defect** — per the
> correction comment on #928 it is not established as embedding-related, and
> nothing here assumes it is.

## Measured ground truth

Everything below is read from the tree at `d9a4708` or measured on this machine.
No estimates.

| Fact | Value | Source |
| --- | --- | --- |
| Boot needs a **writable** vault before the socket binds | `await ensureAnchorKeypair(vault)` | `platform/assemble.ts:1694`, inside `assemblePlatformServices` |
| …and it always writes on a machine where reads fail | `get` → `null` ⇒ both key checks fail ⇒ `generateEd25519Keypair()` ⇒ two `vault.set` calls | `policy/anchor-keypair.ts:26-43` |
| Linux vault **reads** already degrade silently | `get()` catches → `null`; `listKeys()` catches → `[]` | `vault/linux.ts` |
| Linux vault **writes** are the only fatal path | `runSecretTool` throws `Error("Vault operation failed")` on non-zero exit | `vault/linux.ts` |
| `nimbus doctor`'s vault check | `Bun.which("secret-tool") === null` — PATH only | `cli/src/commands/doctor-core.ts`, `doctorPrintVaultCheck` |
| A working headless recipe already exists in-repo | `dbus-run-session` + `gnome-keyring-daemon --unlock --components=secrets` | `scripts/linux/linux-dbus-tests.sh` |
| Default embedding config | `enabled: true`, `provider: "local"` | `DEFAULT_NIMBUS_EMBEDDING_TOML` in `config/nimbus-toml.ts` |
| On `provider = "local"` the model fetch is **already off the bind path** | `tryCreateEmbeddingWorkerBridge` returns the bridge immediately; `waitUntilReady(…)` is fire-and-forget `.then/.catch` | `embedding/worker-bridge.ts:43-56` |
| On `provider = "hybrid"` it is **not** | `localEmbedder = await createEmbedder({…})` on the main thread | `embedding/create-routing-runtime.ts:46` |
| Embedding init timeout | `600_000` ms | `embedding/worker-bridge.ts:15` |
| CLI readiness window | `60_000` ms default | `cli/src/commands/start.ts:18` |
| Pre-ready behaviour | `scheduleItemEmbedding` no-ops, `embedQuery` returns `null`, init failure is a `logger.warn` to a file | `embedding/worker-bridge.ts` |
| The warm-up gap self-heals | worker sends `ready`, then runs `backfillAll` | `embedding/embedding-worker-core.ts:185-203` |
| MiniLM on disk | **22.59 MB** total (`model_quantized.onnx` 21.91 MB, `tokenizer.json` 0.68 MB) | measured, `%LOCALAPPDATA%\nimbus\data\models` |
| Headless installer sizes, v1.6.0 | 49–76 MB (`.pkg` 49, `.deb` 54, `.msi` 63, AppImage 73, `.rpm` 76) | release assets |
| A weight-bundling packager already exists | `--embedding-model-dir`, else materializes weights by running a warm-up embed | `scripts/package-headless-bundle.ts` |
| …and is never invoked with weights | release hand-rolls `dist/headless-bundle` with two `cp`s; CI runs it `--skip-embedding-model` | `release.yml:452-455`, `_test-suite.yml:744` |
| An offline escape hatch exists and is documented | `NIMBUS_EMBEDDING_MODEL_DIR` | `docs/cli-reference.md` env table |

Two of these change the shape of both issues.

**#925 is a write, not a read.** The abort is not "the vault is unreachable"; it
is "boot mints a policy-anchor keypair and stores it". A brand-new user with
zero connector credentials still cannot start, because the gateway needs the
vault for *its own* machine-local key material. Note the second-order effect: if
that `set` were merely made non-fatal, the anchor keypair would silently
regenerate on **every** restart, because the `get` that would have found it also
returns `null`.

**#928's headline is only true off the default path.** With the shipped default
(`provider = "local"`) the model fetch runs in a worker and nothing awaits it.
The awaited-on-the-main-thread fetch is the `hybrid` path, which requires an
OpenAI key. So "first run can block for ten minutes on a cold model fetch" is
real, but as a `hybrid`-only code path — consistent with the issue's own
correction comment, and worth stating before we spend installer bytes on it.

---

## Question 1 — is a headless Linux vault backend in scope?

### The options

**A. Document a supported headless path and treat it as a prerequisite.**
Ship the `dbus-run-session` + `gnome-keyring-daemon --unlock` recipe we already
run in CI, in the README/quickstart and in a failure message.

**B. Add a file-based encrypted backend behind an explicit opt-in.**
A change to non-negotiable #3, which must be argued as such.

**C. Declare headless Linux unsupported and fail fast.**

All three share one item that is **not optional under any of them**: replace the
`Bun.which` PATH check with a live probe, in both the gateway's Linux
`create()` and `nimbus doctor`. Today `doctor` prints `[ok] Vault` on a machine
where every vault write fails. That is the exact anti-pattern of reporting a
PATH check as a health check, and it is why #925 was found by an installer smoke
test rather than by the tool built to find it. The probe must be a real
round-trip (`set` a scratch key, `get` it, `delete` it) — anything cheaper is a
check more lenient than production.

### Why B is a downgrade, not a trade

Non-negotiable #3 buys one specific property: an attacker who can read the
user's disk, a backup, or a shipped log cannot get credentials, because the
secret is bound to the OS login (DPAPI / Keychain / login keyring). A file
backend keeps "no plaintext" only if the file's key comes from somewhere. On a
headless server the realistic sources are:

1. **An interactive passphrase at gateway start.** Preserves the property, and
   kills unattended restart — a non-starter for an on-call ICP whose box reboots
   without them.
2. **An environment variable.** Works headlessly, and puts a plaintext
   long-lived secret in the process environment and almost certainly in a
   systemd unit or a compose file. That is strictly worse than the login
   keyring, and it is the precise thing #3 exists to prevent.
3. **A TPM / `systemd-creds` binding.** Genuinely preserves the property. It is
   also Linux-only, a new platform dependency, and not a launch-sized change.

The version of B that people usually mean is (2). So "add a file backend" as
commonly imagined does not trade one security property for convenience — it
gives up the property and gains nothing that (A) does not already give.

There is a narrower B worth naming, because it is the one I would revisit: split
**machine-local key material the gateway mints for itself** (policy anchor,
federation identity, share signing, recovery seed) from **user credentials**,
and let only the former fall back to a file. That is a smaller blast radius —
no cloud credential ever leaves the OS vault — but it still writes private
*signing* keys to disk, so it is still an amendment to #3 and still needs an
owner decision plus a written invariant change. It is not free and should not be
slipped in.

### Recommendation

**A, plus two fixes that are not really optional.**

1. **A** — document the headless recipe as a prerequisite; we already run it.
2. **Make the boot-time vault write lazy.** Mint the policy anchor on first use,
   not during `assemblePlatformServices`. A headless box with no connectors then
   boots, and `nimbus init`, filesystem indexing and `nimbus why` — none of
   which need a connector credential (`filesystem` declares no secrets in
   `connector-secrets-manifest.ts`, and the boot-time credential reads already
   degrade to `null`) — work. This defers a write; it weakens nothing.
3. **Degrade loudly, not silently.** Lazy-minting alone would reproduce the
   failure mode #925 complains about: a command that exits 0 and produces
   nothing. Pair it with an explicit capability line — `doctor` and `init` must
   say *"Vault: unavailable — connectors, team features and clip pairing are
   disabled on this machine"* and name the recipe.

Reject **C**: it costs the same engineering as A (a probe and a message) and
sheds a chunk of the ICP for no gain. Defer **B** pending owner input below.

### Cost of the recommendation

The honest cost of A is that a container user must wrap the gateway in a session
bus and unlock the keyring non-interactively — in practice with an empty
password, exactly as `linux-dbus-tests.sh:21` does (`echo "" |
gnome-keyring-daemon --unlock`). That form is CI-only today: every call site is a
test path (`_test-suite.yml`, `scripts/lib/ci-tests.ts`,
`scripts/coverage-floor/reseed-docker.sh`), no installer or runtime path invokes
it, and the one headless line we already ship to users (`docs/README.md:311`)
names no password. Promoting it verbatim into the README/quickstart would be the
first time an empty-password unlock appears in a user-facing document, so A ships
it **scoped**:

1. **Scope the empty-password form to CI and disposable dev containers**, at the
   callsite in the docs rather than in a footnote, and say out loud there that a
   keyring unlocked with `""` is not protecting anything at rest.
2. **Any box holding real credentials gets the passphrase-unlocked form**, with
   the consequence stated: the keyring is unlocked once per boot, so unattended
   restart does not survive it.
3. **There is no protected and unattended option at launch.** That is B(3),
   TPM-bound, not B(2), and it is a post-launch project.

This narrows the B(2) argument above: an environment-variable key is strictly
worse than an *interactively unlocked* login keyring, not than an empty-password
one, against which the two are roughly equivalent. B(2) stays rejected (it buys a
new backend and a #3 amendment for nothing), but A's headless variant carries no
at-rest property either and must not be written as if it does. What an empty
password leaves of gnome-keyring's key derivation is not measured anywhere in
this tree, and `vault/linux.ts` never sees a keyring password — it shells out to
`secret-tool` only — so the degradation is entirely at rest, and this fix is
docs-level with no code path behind it.

---

## Question 2 — the first-run contract for embeddings

Four sub-questions, in the order they bite a new user.

### 2a. Ship the model, pre-warm it at install, or fetch lazily?

- **Ship weights in the installer.** 22.59 MB is the **uncompressed** weight
  total, not the installer delta: every headless format compresses its payload,
  and not with one codec (`.deb` `data.tar.zst` zstd, `.rpm`
  `PAYLOADCOMPRESSOR=gzip`, AppImage gzip squashfs, `.pkg` gzip cpio inside the
  xar, `.msi` LZX cabinet — read off the shipped v1.6.0 assets). Compressed
  standalone the four files are 15.1–15.7 MB (measured on the real
  `model_quantized.onnx`: zstd -19 15.09, xz -9 15.11, gzip -9 15.65 MiB), so
  against installers that are 49–76 MB the range is roughly **+20% to +32%**,
  not +30% to +46% — and the exact per-artifact delta is not established until
  each one is rebuilt (`bun scripts/package-headless-bundle.ts`, then
  `bun scripts/package-linux-installers.ts`, diffed against the v1.6.0 assets).
  It is the only option that works air-gapped or behind a proxy that will never
  answer. It also pins the model version to a release — which
  makes vectors reproducible per version — and takes a third-party CDN off the
  first-run critical path, which is a supply-chain reduction as much as a UX one.
- **Pre-warm at install time.** Moves the hang from `nimbus init` into
  `install.sh` / a package post-install hook, and fails in exactly the same
  networks. Network-touching post-install hooks also break image builds, which
  is the ICP's environment.
- **Fetch lazily (today).** Zero installer cost; leaves the CDN in the path.

**Recommendation:** ship the weights in the **headless installers**
(`.deb`/`.rpm`/`.pkg`/`.msi`/AppImage/tarball), where `package-headless-bundle.ts`
already knows how to do it. Note this is a new release-workflow step, not a flag
flip: `release.yml` never invokes that script at all — repo-wide it appears only
in `_test-suite.yml:744` and `package.json:232`. Keep the lazy fetch for the raw
single-binary downloads and for brew/scoop, where even the compressed ~15 MB per
formula is not our budget to spend. Explicitly reject pre-warming at install.

**Costs:** ~15–16 MB per headless installer — 22.59 MB uncompressed, shrunk by
each format's own codec, with the firm number owed from a rebuild before this is
quoted anywhere binding; the release job gains a model
download that must be checksum-pinned like `nfpm` already is; a model bump
becomes a release-notes line. One item must be checked before this lands —
redistributing the MiniLM/Xenova weights inside an AGPL artifact needs a pass
against `docs/license-policy.md` and an entry in the SBOM/NOTICE. I have not
verified that and it should not be assumed.

### 2b. Silent or loud degradation?

Today it is silent three times over: `scheduleItemEmbedding` no-ops,
`embedQuery` returns `null`, and worker init failure is a `logger.warn` into a
file whose path is printed but whose contents never are.

**Recommendation: loud once, at the point of use — never fatal.** The gateway is
genuinely useful without vectors (`nimbus why`, `index.demoSymbol`, FTS search
all work), so a fatal would be a regression. But #895 shipped precisely because
degradation was quiet. Concretely: a capability line in `doctor`/`status`, and a
one-line notice on the first search that *would* have used vectors — "semantic
search is warming up; showing keyword results". Once, not per query.

### 2c. What does the user see while it warms?

Today: a spinner echoing the last gateway stdout line, a 60 s CLI readiness
window, and a 600 s embedding init timeout — the CLI gives up 10× sooner than
the thing it waits on. After bind-first, warming is off the readiness path
entirely and the spinner question dissolves.

**Recommendation:** surface `backfill_progress` — already emitted by the worker
and already tracked on the bridge — as `embedding: warming (n/m)` in
`nimbus status`. That covers one phase. Warm-up has three, they carry three
different signals, and 2d depends on the distinction:

- **download** — `model_progress`, bytes per file, emitted before the worker
  posts `ready`. The in-flight bind-first work (#928) wires it through
  `EmbeddingReadiness.download` to `gateway.ping`; `nimbus status` does not read
  that field yet, and should.
- **model load** — from the last `model_progress` to `ready`. No signal exists
  here. A run that finds the weights already on disk (2a, or
  `NIMBUS_EMBEDDING_MODEL_DIR`) is this phase and nothing else.
- **backfill** — `backfill_progress`, n/m items, emitted only *after* `ready`.

So download progress is not a deferred nice-to-have: the signal exists and 2d
consumes it. What is unbuilt is the CLI rendering.

### 2d. Air-gapped or proxied, where the fetch can never succeed

The escape hatch exists and is documented (`NIMBUS_EMBEDDING_MODEL_DIR`), but a
user reaches it only after a 600 s wait and a log-file warning they were never
told to read.

**Recommendation:**

1. 2a removes this case for installer users.
2. Replace the 600 s **wall-clock** timeout with a **stall** timeout — abort
   when no bytes have arrived for N seconds, not when N seconds have passed.
   Simply lowering 600 → 90 would punish a slow-but-working link, which is a
   check more lenient than the network it models in one direction and stricter
   in the other. A stall timeout is strictly better in both. It is driven by
   `model_progress`, not by `backfill_progress`: the latter is emitted only
   after `ready`, so at the moment a fetch is the thing that has stalled, zero
   of them have been sent. Today `worker-bridge.ts` arms one `setTimeout` and
   races it against readiness; a stall timeout re-arms on each event instead.
   Two things must be settled before it is implementable. The model-load window
   emits nothing, so the timeout has to tolerate a silent stretch after the last
   byte or it will kill a working slow load. And N is unmeasured — take it from
   the worst inter-event gap on a real cold fetch (clear the model cache, run
   `nimbus start` with `NIMBUS_EMBEDDING_INIT_TIMEOUT_MS` raised high enough that
   the run finishes, and log the `model_progress` arrivals), not from a round
   number.
3. The give-up message must name `NIMBUS_EMBEDDING_MODEL_DIR` and
   `[embedding] enabled = false`, not just say "disabled".
4. Do not silently re-attempt the fetch on every restart. Record the state and
   say so.

---

## What I need from the owner

1. **Is headless/container Linux a supported configuration at launch?** If yes,
   B needs a real decision and a written amendment to non-negotiable #3 (and my
   answer would be B(3), TPM-bound, post-launch — not B(2)). If no, A plus the
   lazy write plus the live probe is complete and cheap. **My recommendation:
   no for launch** — laptop-first, with a documented headless path — and revisit
   when a user asks for it rather than because we imagined they would.
2. **Approve ~15–16 MB per headless installer** (22.59 MB uncompressed, before
   each format's codec; firm per-artifact number owed from a rebuild), and
   confirm we may redistribute
   the MiniLM/Xenova weights (license check against `docs/license-policy.md`,
   plus SBOM/NOTICE). If the answer is no, 2a collapses to the lazy fetch and 2b
   through 2d carry the whole first-run contract on their own.

## Out of scope

- Bind-first — being implemented separately.
- The macOS gateway-never-binds failure — a separate, still-undiagnosed defect.
  Note that `install-smoke` has never started a gateway on macOS, so it may be
  long-standing rather than a regression, and it should not be closed by
  anything in this memo.

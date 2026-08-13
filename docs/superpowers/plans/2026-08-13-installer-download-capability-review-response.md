# Installer download capability — plan review response

**Date:** 2026-08-13
**Review:** [`2026-08-13-installer-download-capability-review.md`](./2026-08-13-installer-download-capability-review.md)
**Outcome:** 4 findings accepted (2 with a different fix than proposed), 2 suggestions accepted, 1 sub-part rejected, 1 sub-part deferred as untestable here.

---

## 1. PowerShell redirect resolution under proxies / group policy — SPLIT

**The core mechanism is already verified, not open.** The redirect resolution
was measured on both runtimes before the plan was written — `-UseBasicParsing`
on 5.1 returns the resolved `ResponseUri` correctly, and PS7 returns
`RequestMessage.RequestUri`. There is no open question about whether
`Invoke-WebRequest` follows the redirect; it does, on both.

**Proposed fix rejected.** Switching to `[System.Net.HttpWebRequest]` would not
help with proxies. On 5.1 `Invoke-WebRequest` *is* built on `HttpWebRequest` and
shares the same `System.Net` proxy stack (`WebRequest.DefaultWebProxy` /
`ServicePointManager`); on PS7 it uses `HttpClient`, which honours the same
system proxy configuration. Swapping the API changes the call shape, not the
proxy behaviour.

**Accepted in modified form — the useful half is graceful failure.** Redirect
resolution is the one network step with no fallback, so it gets an explicit
`try`/`catch` (and a non-zero-exit check on the `curl` side) that fails with an
actionable message naming the workaround:

> Could not resolve the latest release tag (network, proxy or firewall). Re-run
> with an explicit version to skip resolution: `--from-release 2.2.0`.

This matters because `--from-release <ver>` bypasses redirect resolution
entirely — a proxied or policy-restricted environment has a real escape hatch,
and the error message should say so rather than leaving the user to discover it.

**Deferred:** actually testing corporate-proxy and group-policy environments.
Not reproducible on this machine or on GitHub runners, so any claim about them
would be unverified. Recorded as a known untested surface rather than asserted
as working.

## 2. Windows background HTTP server in CI — ACCEPTED, better fix applied

**The finding is correct, and it flags a real plan defect.** "Mirror for Windows
with `Expand-Archive`-compatible zip packing" is exactly the kind of
describe-don't-show step the writing-plans skill treats as a plan failure. The
Windows half was underspecified.

**Proposed fix superseded.** `Start-Process python -PassThru` works, but it
introduces a second, OS-divergent server implementation and a dependency on
Python being present and being the *same* Python on all three runners.

**Applied instead:** one Bun-based fixture server, `scripts/install/serve-fixture.ts`,
used identically on all three OSes. Bun is already provisioned on every runner by
`.github/actions/setup-nimbus-ci`, so this removes the Python dependency rather
than relocating it — and it reuses the same `Bun.serve` shape the unit test in
Task 3 already uses, so the served-release fixture has one implementation, not
three. Process lifecycle is handled by the script writing its own PID and the
job killing it in an `always()` step, which also addresses the orphan concern
the review raised.

## 3. Temp directory cleanup on failure or interrupt — ACCEPTED

Correct. `mktemp -d` directories survive every failure path in the drafted
script, and an interrupted download leaves both `$DOWNLOAD_DIR` and `$GNUPGHOME`
behind. This also lines up with a known repo-level concern — CI temp-dir litter
has been a recurring problem here.

**Applied with one hardening the review did not include.** The suggested trap,
written literally, expands unset variables:

```sh
trap 'rm -rf "$DOWNLOAD_DIR" "$GNUPGHOME"' EXIT INT TERM   # unguarded
```

If either variable is unset the command becomes `rm -rf ""`, which is harmless
today but is one editing accident away from expanding to something that is not.
A cleanup handler that runs `rm -rf` on an unvalidated path is not a place to be
casual, so the trap guards each path before removing it:

```sh
cleanup() {
  [ -n "${DOWNLOAD_DIR:-}" ] && [ -d "${DOWNLOAD_DIR:-}" ] && rm -rf "$DOWNLOAD_DIR"
  [ -n "${GNUPGHOME:-}" ] && [ -d "${GNUPGHOME:-}" ] && rm -rf "$GNUPGHOME"
  return 0
}
trap cleanup EXIT INT TERM
```

Cleanup at `EXIT` is safe for the success path: the binaries are copied out of
`$DOWNLOAD_DIR` before the script ends. PowerShell gets the `try`/`finally`
equivalent.

## 4. GPG key encoding on Windows — ACCEPTED, verified

**Measured, not assumed.** Windows PowerShell 5.1 `Out-File` writes UTF-16LE
with a BOM; PowerShell 7 writes UTF-8:

```
PS 5.1  Out-File first 6 bytes : FF FE 2D 00 2D 00   <- UTF-16LE + BOM
PS 7.6  Out-File first 6 bytes : 2D 2D 2D 2D 2D 42   <- UTF-8
```

`gpg --import` cannot parse a UTF-16 armored block, so the embedded key would
fail to import on exactly the runtime we just committed to supporting. The
finding is more load-bearing than it looks: it only bites on 5.1, and 5.1 became
a supported target in the design review.

It is also more likely to be hit than "gpg is absent on Windows" suggests — Git
for Windows bundles `gpg` and commonly puts it on `PATH`.

**Applied:** write the key with an explicit encoding and no BOM —
`[System.IO.File]::WriteAllText($path, $key, [System.Text.UTF8Encoding]::new($false))`
— never `Out-File`, `>`, or a pipeline into `gpg`. `UTF8Encoding::new($false)`
is required rather than `-Encoding utf8`, because on 5.1 that switch emits a BOM
which `gpg` also rejects.

## Suggestions

- **GPG responsiveness check — ACCEPTED.** `command -v gpg` / `Get-Command gpg`
  can resolve a broken symlink or a stub. Since signature verification is
  best-effort, a `gpg` that errors on invocation must degrade to "not checked"
  rather than abort the install. The guard becomes "runs `gpg --version`
  successfully", not "is on PATH".
- **Clearer skip message — ACCEPTED.** The skip line states plainly that only
  the SHA-256 manifest was checked, that the manifest was fetched over the same
  channel as the archive, and that this does not prove publisher authenticity —
  with the `nimbus-verify.sh` invocation to do so. This matches the spec's rule
  that the script never claims more than it did.

---

## Net effect on the plan

- Task 3 gains the guarded `trap` and the actionable redirect-failure message.
- Task 4 gains the `try`/`finally` equivalent and the same failure message.
- Task 5 gains explicit UTF-8-no-BOM key writing, the `gpg --version` liveness
  check, and the expanded skip wording.
- Task 6 replaces the Python one-liner with `scripts/install/serve-fixture.ts`,
  used identically on all three OSes, plus an `always()` teardown step.

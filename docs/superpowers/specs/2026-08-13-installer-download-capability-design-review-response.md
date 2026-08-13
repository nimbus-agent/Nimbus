# Installer download capability — design review response

**Date:** 2026-08-13
**Reviews:** [`2026-08-13-installer-download-capability-design-review.md`](./2026-08-13-installer-download-capability-design-review.md)
**Outcome:** 4 accepted, 1 deferred, 2 proposed fixes rejected in favour of verified alternatives, 1 escalated for a scope decision.

Every finding below was checked against a live run or the real published
release, not reasoned about. Where a finding was right but its proposed fix was
wrong, both are recorded.

---

## 1. PowerShell 5.1 compatibility — ACCEPTED (finding), REJECTED (proposed fix), ESCALATED (scope)

**Verified.** Two separate defects, both real, and the second is in the spec I
wrote.

*The `#Requires` guard does not fire under `iex`.* `install.ps1` declares
`#Requires -Version 7.0` on line 1, so I initially read PS 5.1 as already out of
scope. It is not — that declaration is silently bypassed when the script is
evaluated as text:

```text
PS 5.1.26100.9168 > Invoke-Expression "#Requires -Version 7.0`nWrite-Host RAN-ANYWAY"
RAN-ANYWAY
```

Stock Windows 10/11 ships 5.1 as `powershell.exe`; PS7 (`pwsh.exe`) is a
separate install. So the documented `irm | iex` one-liner runs the script under
5.1 on a default machine, with its version guard inert.

*The spec's own redirect snippet null-derefs on 5.1.* Measured on both runtimes:

| | PS 5.1 | PS 7.6 |
| --- | --- | --- |
| `BaseResponse` type | `System.Net.HttpWebResponse` | `System.Net.Http.HttpResponseMessage` |
| `BaseResponse.RequestMessage` | **`<NULL>`** | the resolved URI |
| `BaseResponse.ResponseUri` | the resolved URI | **property absent** |

The spec proposed `$r.BaseResponse.RequestMessage.RequestUri`, which is PS7-only
and null-derefs on 5.1 — structurally the same defect as the
`$MyInvocation.MyCommand.Path` bug this work exists to fix. Corrected to probe
both properties.

**Proposed fix rejected.** The review suggested `[System.Net.HttpWebRequest]` or
catching the redirect exception. That addresses redirect *mechanics*, which were
never broken — both runtimes resolve the redirect fine. The actual gaps are the
bypassed version guard and a runtime-specific property. Using the raw
`HttpWebRequest` API would not have fixed either.

**Escalated.** Whether to *support* 5.1 or *refuse cleanly* on it is a scope
decision, not a technical one — see [Open decision](#escalated-decision--resolved-2026-08-13) below. Either
way, the version guard and the cross-runtime redirect are in.

## 2. Asset versioning inconsistency — ACCEPTED (finding), REJECTED (proposed fix)

**The finding is correct and the defect is mine.** The spec routed macOS and
Windows through `/releases/latest/download/`, which ignores a pinned version, so
`--from-release v2.1.0` would have silently installed the latest build on those
two platforms. A pinned-version flag that returns something other than the
pinned version is worse than not having the flag.

**Proposed fix rejected.** The review suggested aligning the naming scheme so all
platforms carry a `-v<ver>` suffix. That would break every documented
unversioned URL — `docs/install.md`, `verify-your-download.mdx` — which is
precisely the breakage the aliasing block at `release.yml:640-657` was added to
repair (`latest/download/<name>` resolves an exact name and does not glob, so a
versioned filename cannot be linked from docs that outlive one release).
Renaming assets to fix an installer bug would re-open a docs bug that was
deliberately closed.

**Applied instead:** resolve the tag once, then use
`/releases/download/<tag>/<name>` uniformly for **every** platform. No asset is
renamed, `--from-release` becomes correct everywhere, and the two-base-URL
inconsistency disappears. Verified against the live release — the tag-pinned
path serves the unversioned assets too:

```text
/releases/download/v2.2.0/nimbus-headless-macos-arm64.tar.gz -> HTTP 200
/releases/download/v2.2.0/SHA256SUMS                          -> HTTP 200
```

Asset names in the spec's table were also checked against `gh release view
v2.2.0` and match exactly.

## 3. GPG key retrieval — ACCEPTED, with the security claim corrected

Keyserver lookups are genuinely unreliable (transient failures, timeouts,
corporate firewalls), and `nimbus-verify.sh` does default to
`keys.openpgp.org`. Under a best-effort signature policy an unreachable
keyserver degrades silently to "signature not verified" — so the practical
outcome is that the signature check would rarely run at all, which is
verification theatre.

**Applied:** embed the ASCII-armored public key inline in both scripts and import
it into a temporary `GNUPGHOME`. No network fetch for the key.

**One correction to the review's framing:** this is a *reliability* fix, not a
stronger trust root. The review implies embedding is more trustworthy than a
keyserver; it is not. An attacker who can tamper with the delivered script can
swap the embedded key just as easily as they could tamper with a pinned
fingerprint. Both defend a compromised *release asset* given an authentic
*script*, and neither defends a compromised script. The reason to embed is that
it makes the check actually happen.

## 4. Keyring directory permissions — ACCEPTED

Correct and concrete. `gnome-keyring` cares about mode, and directories created
under a default umask land at `0755`. Added as an explicit constraint and an
acceptance criterion: `0700` on `~/.local/share/keyrings`, `0600` on keyring
files.

This constrains the mechanism without specifying it, so it does not conflict
with the spec's deliberate refusal to pin the mechanism before the container
spike.

## 5. `wget` fallback — DEFERRED

The portability concern is real in general but does not reach the path in
question:

- **The documented entry point is `curl -fsSL <url> | sh`.** A user who can run
  the one-liner already has `curl`, by construction. The fallback would only
  matter for `install.sh --from-release` invoked from an already-downloaded
  script — a narrow case.
- **Alpine specifically is a non-target.** The binaries are `bun build
  --compile` output linked against glibc; Alpine is musl. A busybox-`wget`
  Alpine box cannot run the binary the installer would fetch, so downloading it
  successfully changes nothing.
- A second download backend doubles the surface of the most security-sensitive
  code in the script — fetch, then hash-verify — for a case the documented path
  cannot reach.

Revisit if a `wget`-based one-liner is ever published, which would invert the
first point.

## Implementation suggestions

- **PS 5.1 CI leg — conditionally accepted.** Follows from the scope decision
  below. If we refuse on 5.1, CI asserts the guard *fires* with a clear message;
  if we support 5.1, CI runs the full install under `powershell.exe`. Either is
  a real test; which one depends on the decision.
- **Keyring dry run — accepted.** `--fix-keyring` gets explicit `--dry-run`
  support and, on an interactive TTY, prints the exact planned actions and asks
  for confirmation. This sharpens what the spec already required ("announces
  what it will do before doing it") into a testable surface.

---

## Escalated decision — RESOLVED 2026-08-13

**Windows PowerShell 5.1 is supported.** Refusing would leave the flagship
one-liner broken on a stock Windows box, which is the same class of failure as
issue #1167 and sits badly against non-negotiable #5 (platform equality).

Accepted cost: explicit TLS 1.2
(`[Net.ServicePointManager]::SecurityProtocol`), `-UseBasicParsing`, the dual
redirect property above, a runtime version floor replacing the inert
`#Requires`, and a 5.1 CI leg that runs the full documented one-liner rather
than asserting a guard fires.

Recorded in the spec under *Resolved: PowerShell 5.1 is supported*.

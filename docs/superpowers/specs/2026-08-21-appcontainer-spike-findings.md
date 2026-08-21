# AppContainer ACL spike — findings (Task 1)

**Verdict: GO.** Probes A, B and C all produced the required outcome — a Bun child
process runs inside a Windows AppContainer with inherited stdio, real pipes carry
data across the sandbox boundary, and a path outside the granted directory is
denied with `EPERM`. The approach in the spec (AppContainer + ACL grants +
inherited stdio) is viable, **but the ACL grant scope the brief's `spike.c` uses
(a single `EXPLICIT_ACCESS` on the leaf scratch directory) is insufficient on its
own.** Getting a real Bun process — not a system binary — to run a script file
required two additions beyond what the brief's code grants, discovered by
iterating on this spike:

1. **Read+execute (not traverse-only) on every ancestor directory** between the
   scratch root and the AppContainer's own home volume subtree the process was
   launched under (here: `C:\Temp` and `C:\Temp\acl-spike`, ancestors of the
   granted `C:\Temp\acl-spike\work` leaf). Bun's startup walks *upward* from the
   script's directory looking for `package.json`/`bunfig.toml` to establish a
   project root, which needs list access on each ancestor, not merely the
   traverse (`X`) bit. Traverse-only ancestors reproduced a `CouldntReadCurrentDirectory`
   internal error; upgrading the ancestors to `(RX)` changed the failure to a
   file-level `EPERM` on the script itself.
2. **Modify (not just read+execute) on the leaf scratch directory itself.**
   `fs.readFileSync` of the script succeeded under read+execute alone, and
   `bun -e` / `bun --version` (which never load a script file) succeeded too —
   proving the base spawn/pipe mechanism was never the problem. Only *running a
   file as the entry script* needed write access on its containing directory,
   most likely for Bun's own startup housekeeping next to the script. Granting
   `(OI)(CI)(M)` on the leaf directory made Probe A pass outright.

No grant was ever needed on the volume root (`C:\`) itself — `C:\Windows` and
`C:\Windows\System32` both carry `APPLICATION PACKAGE AUTHORITY\ALL APPLICATION
PACKAGES:(RX)` directly on themselves (confirmed via `icacls`), and once the
scratch tree's own ancestors got equivalent per-directory grants, drive-root
access was never required. This is the concrete answer to the "real unknown"
the spec named: it *is* solvable for a user-profile binary, but the write-up's
one-ACE recipe is not the whole recipe — Task 3's real helper needs to grant
`(RX)` up the ancestor chain to whatever base directory Nimbus controls, and
`Modify` (not read-only) on the leaf working directory.

Container SID for this run: `S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843`
(profile name `nimbus-spike`, created fresh — `CreateAppContainerProfile` hit
the happy path, not the `ERROR_ALREADY_EXISTS` fallback).

Environment: MSVC Build Tools 18 (`vcvars64.bat` + `cl /W4 /nologo`), Bun
`v1.3.14` (Windows x64), scratch root `C:\Temp\acl-spike` as directed. The
`spike.c` source compiled is byte-for-byte the listing in
`task-1-brief.md` Step 1 — the additional ACL grants below were applied with
`icacls`/PowerShell *around* that unmodified binary, not by editing the probe.

---

## Probe A — does a Bun child run at all inside the container, with stdout captured?

**Command (as specified in the brief, leaf-only ACL grant):**

```
spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\hello.js
```

**Actual output (first attempt, leaf dir granted `GENERIC_READ|GENERIC_EXECUTE`
only, no ancestor grants):**

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
error loading current directory
error: An internal error occurred (CouldntReadCurrentDirectory)
child exit: 1
```

**Result: FAIL as literally specified.**

### Diagnosis (why, and what fixed it)

This is not the failure the brief anticipated ("can't open a file whose ACL
doesn't name the SID") — it happened before Bun ever touched `hello.js`. Isolating
it:

| Test | Result |
| --- | --- |
| `cmd.exe /c cd` with the same cwd, leaf dir + ancestor `(X)`-only grants | **succeeds** — prints the cwd. Rules out a drive-root traversal problem; a plain Win32 `GetCurrentDirectoryW` caller is fine. |
| `bun.exe -e "console.log(1+1)"` (no script file) | **succeeds** — prints `2`. Rules out AppContainer spawn/stdio being broken for Bun generally. |
| `bun.exe --version` | **succeeds** — prints `1.3.14`. |
| `bun.exe -e "require('fs').readFileSync('...hello.js','utf8')"` | **succeeds** — prints the file's source. Rules out the leaf-file ACL grant itself being wrong. |
| `bun.exe hello.js` (run-as-script, relative or absolute) with ancestors at `(X)`-only | **fails**, same `CouldntReadCurrentDirectory` |
| Same, with ancestors (`C:\Temp`, `C:\Temp\acl-spike`) upgraded to `(RX)` | **error changes** to `EPERM: operation not permitted, open 'C:\Temp\acl-spike\work\hello.js'` — progress, but still a fail |
| Same, plus leaf `work` dir upgraded from `(RX)` to `(OI)(CI)(M)` (Modify) | **succeeds** — prints `hello` |

Conclusion: running a script file (as opposed to `-e`/`--version`/manual
`readFileSync`) makes Bun walk its directory ancestors (needing `(RX)`, not
just `(X)`) and needs write access on the script's own directory (needing
`Modify`, not just `(RX)`). Whatever Bun does with that write access wasn't
characterized further (out of scope for a throwaway spike — plausibly a
startup lockfile, compile-cache, or similar housekeeping artifact written next
to the entry script); the fact that `-e` mode and manual `readFileSync` both
avoid needing it confirms it is specific to Bun's script-loading path, not to
file reads in general.

**Final command + output, with the full recipe applied:**

```
spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\hello.js
```

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
hello
child exit: 0
```

**Result: PASS** (with the extended ACL recipe above; FAIL with the brief's
literal single-ACE grant).

---

## Probe B — is stdin/stdout a real pipe, not just a console?

**Command:**

```
echo x | spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\stdintest.js
```

(`stdintest.js` — equivalent to the brief's inline `-e` script, moved to a file
to sidestep `cmd.exe` quoting: `process.stdin.once('data', (d) =>
process.stdout.write('got:' + d));`)

**Actual output (with the full ACL recipe already applied from Probe A):**

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
got:x
child exit: 0
```

**Result: PASS.** `got:x` confirms the piped byte crossed the AppContainer
boundary through `STARTF_USESTDHANDLES`-inherited handles — a real pipe, not a
console buffer.

---

## Probe C — is a path OUTSIDE the granted directory actually denied?

**Command:**

```
spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\probec.js
```

(`probec.js`: `require('fs').readFileSync(process.env.USERPROFILE +
'/.gitconfig');` — `.gitconfig` confirmed present at that path before the run.)

**Actual output:**

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
1 | require("fs").readFileSync(process.env.USERPROFILE + "/.gitconfig");
                  ^
EPERM: operation not permitted, open 'C:\Users\asafg/.gitconfig'
    path: "C:\\Users\\asafg/.gitconfig",
 syscall: "open",
   errno: -1,
    code: "EPERM"
child exit: 1
```

**Result: PASS (required).** The container could not read a file in the
invoking user's own home directory despite running under that user's account —
the isolation is real, not merely file-permission theater. This is the
load-bearing result: if this had succeeded, the whole design would have been
wrong, per the brief's own stop condition. It did not succeed.

---

## Probe D — non-NTFS volume (substituted per controller ruling)

**This machine has no non-NTFS volume** (`Get-Volume` shows only NTFS) and no
VHD was created and no elevation was requested, per the controller's explicit
ruling for this task. **The non-NTFS trigger itself was NOT exercised.** What
was exercised instead is the `SetNamedSecurityInfoW`-fails branch of the same
code path, using a directory whose DACL this account cannot rewrite as a
deterministic substitute available on any machine.

**Command (controller-specified substitute path):**

```
spike.exe C:\Windows\System32\config C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\hello.js
```

**Actual output:**

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
GetNamedSecurityInfoW: 5
```

Exit code: `2`. `C:\Windows\System32\config` (the registry hive backing
directory) is locked down tightly enough that even *reading* its DACL is
denied to this account (`5` = `ERROR_ACCESS_DENIED`), one step earlier in
`spike.c`'s sequence than the brief's anticipated `SetNamedSecurityInfoW`
failure.

A second, less-restrictive protected path — `C:\Windows\System32` itself —
reaches the exact step the brief describes:

```
spike.exe C:\Windows\System32 C:\Windows\System32\cmd.exe /c echo hello-from-system32
```

```
container SID: S-1-15-2-2090534939-2725333364-795783768-2702357211-2326289060-1809957255-1821817843
SetNamedSecurityInfoW: 5 (NON-NTFS?)
```

Exit code: `4` — matches the brief's documented shape for the exit-4 path
(`GetNamedSecurityInfoW` succeeds, since `C:\Windows\System32`'s DACL is
readable even though owned by TrustedInstaller; `SetNamedSecurityInfoW` then
fails with `ERROR_ACCESS_DENIED`, the same Win32 error code `5` a genuinely
non-NTFS filesystem would surface for the same call, per the brief).

**Result: informational only, as directed.** Both substitute runs prove the
`SetNamedSecurityInfoW`-fails branch is reachable and produces a
distinguishable, non-crashing error path (exit 2 or 4 depending on how far the
directory's own protection extends) — useful signal for Task 4's error
handling, but not proof that a real non-NTFS volume behaves identically.

---

## Cleanup

Root cause required two ACL changes outside the throwaway scratch tree during
investigation: `(X)` and later `(RX)` grants for the container SID on the
shared `C:\Temp` directory (an ancestor of the scratch root, not itself part
of it). This was reverted before commit — `C:\Temp`'s ACL was restored to its
original state (no container-SID ACE) via PowerShell `Get-Acl`/`Set-Acl`. The
entire `C:\Temp\acl-spike` scratch tree (`spike.c`, `spike.exe`, `spike.obj`,
`build_spike.bat`, and `work\` with `bun.exe`/`hello.js`/`stdintest.js`/`probec.js`)
was deleted per Step 5. The `nimbus-spike` AppContainer profile registration
itself was left in place — the brief's Step 5 does not call for
`DeleteAppContainerProfile`, and no CLI ships one by default; it is an inert,
harmless leftover mapping a name to a SID in this user's profile.

## Implication for Task 3

The real helper cannot copy `spike.c`'s single-`EXPLICIT_ACCESS` grant
verbatim and expect a Bun child to run a script file. It needs, at minimum:

- `(RX)`, not `(X)`, on every ancestor directory between the sandboxed
  working directory and wherever Nimbus's own writable base directory begins
  (so Bun's upward `package.json`/`bunfig.toml` walk can list each level).
- `Modify`, not read-only, on the leaf working directory the child is spawned
  into (so Bun's own script-loading housekeeping can write there).
- No grant is needed on the volume root — matching directories
  (`C:\Windows`, `C:\Windows\System32`) already carry `ALL APPLICATION
  PACKAGES` natively, and this spike's scratch tree needed nothing above its
  own ancestor chain once that chain itself was `(RX)`.

This does not change the go/no-go: Probes A/B/C all pass with the extended
recipe, and Probe C still proves real isolation. But Task 3-6 planning should
treat "grant scope" as a richer, per-directory-level concern (read+list on
ancestors, write on the leaf) rather than the one-line `EXPLICIT_ACCESS` call
the spec's spike code shows — that snippet was correct as an isolation
demonstration and as Probe C's negative-result mechanism, but incomplete as
the real helper's grant policy.

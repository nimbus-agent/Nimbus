# Windows sandbox leg + sandbox policy shape — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the platform sandbox real on Windows and widen `SandboxRunner`'s input from an extension manifest to a capability policy, so a one-shot execution can use it.

**Architecture:** Mirror the Linux design rather than the `bun:ffi` route the current stub's error message assumes. A small unprivileged C helper (`nimbus-sandbox-helper.exe`) creates/derives an AppContainer profile, grants the container SID the ACEs the child needs, assigns a Job Object for lifetime, and `CreateProcessW`s the child inside the container — inheriting the stdio handles Node gave the helper, so MCP JSON-RPC over stdio and `ChildProcess` semantics both survive untouched. Separately, `SandboxRunner.spawn` stops taking a whole `ExtensionManifest` and takes a `SandboxPolicy`, with one `policyFromManifest()` derivation.

**Tech Stack:** TypeScript 7 strict / Bun 1.2+ · C99 compiled with MSVC `cl.exe` · Win32 (AppContainer, Job Objects, `SetEntriesInAclW`) · Biome · `bun test`

**Spec:** [`docs/superpowers/specs/2026-08-21-windows-sandbox-and-policy-design.md`](../specs/2026-08-21-windows-sandbox-and-policy-design.md)
Review + disposition: [`…-design-review.md`](../specs/2026-08-21-windows-sandbox-and-policy-design-review.md) · [`…-design-review-response.md`](../specs/2026-08-21-windows-sandbox-and-policy-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Platform equality** (Non-Negotiable #5). This plan exists because it was violated. Nothing here may ship a Windows-only or POSIX-only assumption.
- **Invariant triple rule.** Wiring + docs + enforcement test land in the same commit. `I15` / static `D10` govern this subsystem: every lazy-mesh `ServerSpec` passes through `wrapServerSpec()` into the sandbox. Nothing in this plan may weaken that.
- **Fail closed.** A sandbox that cannot enforce its policy must refuse to spawn, never spawn unsandboxed. The current `win32.ts` throw is correct in posture and wrong only in that it is permanent.
- **Cross-platform paths.** `path.join()` / `os.tmpdir()`, never hardcoded separators. `bun run audit:cross-platform` flags Windows-separator path assertions; escape hatch is `// cross-platform-ok`.
- **Never commit on `main`.** Work happens on `dev/asafgolombek/windows-sandbox-policy`, already checked out at `.claude/worktrees/dev+asafgolombek+windows-sandbox-policy`.
- **`git commit -m` eats backticks** in this shell. Use `git commit -F -` with a heredoc, and keep backticks out of commit subjects.
- **Verify before claiming.** `bun run preflight:fast` after every code change; the full `bun run preflight` before the PR.
- **Test data never touches real user state.** `%LOCALAPPDATA%\Nimbus`, `%APPDATA%\Nimbus` and the config directory hold the live Gateway database and are READ-ONLY here. Scratch files go in the session scratchpad or a fresh `mkdtemp`; cleanup deletes only a directory this task created, by full path, never a parent. When a measurement needs a *path shape* — nesting depth, drive, profile-relative position — build an equivalent shape under the scratchpad rather than borrowing a real one. (Added after a task doing exactly that force-deleted inside the live data directory; the database survived, but only by luck.)

## Decisions taken in this plan

The spec left one question open for the plan. It is settled here:

**Language: C99 compiled with MSVC, not Rust.** Reasons, in order of weight:

1. The helper is a security-critical component. The `windows` crate pulls a large dependency tree into it; the Win32 surface used here is a C API, and the crate is a binding over exactly these calls. Fewer moving parts for the same functionality.
2. The repo's only Rust is the Tauri UI workspace. A second crate outside it means new `cargo-deny` / `cargo-audit` coverage on the release path.
3. It mirrors `packages/gateway/src-native/sandbox-helper/main.c`, so a reader who knows one knows the other.

MSVC is preinstalled on `windows-2025` runners. There is no `make`, so the build is a PowerShell script that locates `VsDevCmd` through the fixed-path `vswhere.exe` and invokes `cl.exe`.

## File Structure

**Created**

| Path | Responsibility |
|---|---|
| `packages/gateway/src-native/sandbox-helper-win32/main.c` | The helper. Argument parsing, `--check-caps`, `--list-profiles`, `--delete-profile`, and the spawn path (profile → ACEs → Job Object → `CreateProcessW` → wait → propagate). |
| `packages/gateway/src-native/sandbox-helper-win32/README.md` | Modes, exit-code contract, why it is unprivileged. Mirrors the Linux helper's README. |
| `scripts/build-sandbox-helper-win32.ps1` | Locates MSVC via `vswhere`, compiles `main.c` to `nimbus-sandbox-helper.exe`. |
| `packages/gateway/src/platform/sandbox/sandbox-policy.ts` | `SandboxPolicy` type + `policyFromManifest()`. The single manifest→policy derivation. |
| `packages/gateway/src/platform/sandbox/sandbox-policy.test.ts` | Unit tests for the derivation. |
| `packages/gateway/src/platform/sandbox/win32-argv.ts` | Pure derivation of the helper argv from a policy. Split out so it is testable on Linux, keeping the CI-Linux coverage run honest. |
| `packages/gateway/src/platform/sandbox/win32-argv.test.ts` | Unit tests for that derivation. |
| `packages/gateway/src/platform/sandbox/win32-reap.ts` | Production `enumProfiles` / `deleteProfile` implementations backed by the helper, plus the boot entry point. |
| `packages/gateway/src/platform/sandbox/win32-reap.test.ts` | Unit tests with an injected runner. |
| `packages/gateway/test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts` | **The primary deliverable test.** Real spawn through `__nimbus-sandbox` on all three OSes. |

**Modified**

| Path | Change |
|---|---|
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts` | `SandboxSpawnOptions.manifest` → `policy`. |
| `packages/gateway/src/platform/sandbox/{linux,darwin}.ts` | Parameter type only. |
| `packages/gateway/src/platform/sandbox/win32.ts` | Stub → real runner. |
| `packages/gateway/src/platform/sandbox/win32.test.ts` | Invert the "spawn throws" test. |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` | Read `NIMBUS_SANDBOX_POLICY_JSON`. |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | Emit the policy env var. |
| `packages/gateway/src/platform/assemble.ts:2256` | Wire the reaper after `createSandboxRunner()`. |
| `package.json` | `build:sandbox-helper:win32` script. |
| `.github/workflows/_test-suite.yml` | Windows build step in the Sandbox gate. |
| `.github/workflows/release.yml` | Windows zip staging + MSI staging. |
| `scripts/package-windows-installer.ps1`, `scripts/release/nimbus.wxs` | MSI payload. |
| `docs/sandbox.md`, `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `.claude/commands/nimbus-{security-invariants,file-map}.md` | Docs that must match what ships. |

---

### Task 1: Spike — prove AppContainer + ACL + stdio end to end

**This task produces an answer, not code you keep.** Everything written here is throwaway and is deleted at the end of the task. Only the findings note is committed.

The spec names one real unknown: an AppContainer process can only open files whose ACL names its package SID or `ALL_APPLICATION_PACKAGES`. `System32` qualifies; a Bun binary in a user-profile directory does not. If that cannot be solved, the whole approach changes.

**Files:**

- Create (throwaway): `%TEMP%\acl-spike\spike.c`
- Create (committed): `docs/superpowers/specs/2026-08-21-appcontainer-spike-findings.md`

**Interfaces:**

- Consumes: nothing.
- Produces: a go / no-go decision for Tasks 3–6. No code.

- [ ] **Step 1: Write the probe**

Create `spike.c` in a scratch directory outside the repo. It must do exactly the sequence the real helper will do, in the same order:

```c
#include <windows.h>
#include <userenv.h>   /* CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName */
#include <aclapi.h>    /* GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW */
#include <sddl.h>      /* ConvertSidToStringSidW */
#include <stdio.h>

int wmain(int argc, wchar_t **argv) {
    if (argc < 3) { fwprintf(stderr, L"usage: spike <scratch-dir> <child.exe> [args...]\n"); return 64; }
    const wchar_t *dir = argv[1];
    PSID sid = NULL;
    HRESULT hr = CreateAppContainerProfile(L"nimbus-spike", L"nimbus-spike", L"spike", NULL, 0, &sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(L"nimbus-spike", &sid);
    }
    if (FAILED(hr)) { fwprintf(stderr, L"profile: hr=0x%08lx\n", (unsigned long)hr); return 1; }

    wchar_t *sidstr = NULL;
    ConvertSidToStringSidW(sid, &sidstr);
    fwprintf(stderr, L"container SID: %s\n", sidstr);

    /* Grant the container SID read+execute on the scratch dir, inheritable. */
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    DWORD rc = GetNamedSecurityInfoW((LPWSTR)dir, SE_FILE_OBJECT,
                                     DACL_SECURITY_INFORMATION, NULL, NULL, &old_acl, NULL, &sd);
    if (rc != ERROR_SUCCESS) { fwprintf(stderr, L"GetNamedSecurityInfoW: %lu\n", rc); return 2; }

    EXPLICIT_ACCESS_W ea;
    ZeroMemory(&ea, sizeof(ea));
    ea.grfAccessPermissions = GENERIC_READ | GENERIC_EXECUTE;
    ea.grfAccessMode        = GRANT_ACCESS;
    ea.grfInheritance       = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
    ea.Trustee.TrusteeForm  = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType  = TRUSTEE_IS_GROUP;
    ea.Trustee.ptstrName    = (LPWSTR)sid;

    rc = SetEntriesInAclW(1, &ea, old_acl, &new_acl);
    if (rc != ERROR_SUCCESS) { fwprintf(stderr, L"SetEntriesInAclW: %lu\n", rc); return 3; }
    rc = SetNamedSecurityInfoW((LPWSTR)dir, SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION, NULL, NULL, new_acl, NULL);
    if (rc != ERROR_SUCCESS) { fwprintf(stderr, L"SetNamedSecurityInfoW: %lu (NON-NTFS?)\n", rc); return 4; }

    /* Spawn inside the container, inheriting OUR stdio handles. */
    SECURITY_CAPABILITIES caps;
    ZeroMemory(&caps, sizeof(caps));
    caps.AppContainerSid = sid;

    SIZE_T sz = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &sz);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs =
        (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, sz);
    if (!InitializeProcThreadAttributeList(attrs, 1, 0, &sz)) { return 5; }
    if (!UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &caps, sizeof(caps), NULL, NULL)) { return 6; }

    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.StartupInfo.hStdError  = GetStdHandle(STD_ERROR_HANDLE);
    si.lpAttributeList = attrs;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    /* argv[2..] joined with spaces is enough for a spike; the real helper quotes properly. */
    wchar_t cmdline[4096];
    swprintf(cmdline, 4096, L"%s", argv[2]);
    for (int i = 3; i < argc; i++) { wcscat_s(cmdline, 4096, L" "); wcscat_s(cmdline, 4096, argv[i]); }

    if (!CreateProcessW(NULL, cmdline, NULL, NULL, TRUE,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                        NULL, dir, &si.StartupInfo, &pi)) {
        fwprintf(stderr, L"CreateProcessW: %lu\n", GetLastError());
        return 7;
    }
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    fwprintf(stderr, L"child exit: %lu\n", code);
    return (int)code;
}
```

- [ ] **Step 2: Build it**

From a Developer PowerShell (or after running `VsDevCmd.bat -arch=amd64`):

```powershell
cl /W4 /nologo spike.c /link userenv.lib advapi32.lib
```

- [ ] **Step 3: Run the four probes and record each outcome**

Copy a Bun binary and a trivial script into the scratch dir first, so the child is a real Bun process rather than a system binary that would pass for the wrong reason.

```powershell
mkdir C:\Temp\acl-spike\work
Copy-Item (Get-Command bun).Source C:\Temp\acl-spike\work\bun.exe
Set-Content C:\Temp\acl-spike\work\hello.js 'process.stdout.write("hello\n")'

# Probe A — does a Bun child run at all inside the container, with stdout captured?
.\spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\hello.js

# Probe B — is stdin/stdout a real pipe, not just a console? Pipe input through it.
"x" | .\spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe -e "process.stdin.once('data',d=>process.stdout.write('got:'+d))"

# Probe C — is a path OUTSIDE the granted dir actually denied?
.\spike.exe C:\Temp\acl-spike\work C:\Temp\acl-spike\work\bun.exe -e "require('fs').readFileSync(process.env.USERPROFILE+'/.gitconfig')"

# Probe D — what happens on a non-NTFS volume? Use a FAT32/exFAT USB stick or a mounted VHD.
.\spike.exe E:\acl-spike C:\Temp\acl-spike\work\bun.exe C:\Temp\acl-spike\work\hello.js
```

Required outcomes: A prints `hello`; B prints `got:x`; C **fails** with a permission error (if it succeeds, the sandbox is not isolating and the approach is wrong); D fails at `SetNamedSecurityInfoW` with exit 4 — that is the non-NTFS signal Task 4 turns into a distinguishable error.

- [ ] **Step 4: Write the findings note**

Create `docs/superpowers/specs/2026-08-21-appcontainer-spike-findings.md` recording, for each probe: the command, the actual output, and pass/fail. Include the container SID string and the `SetNamedSecurityInfoW` error number from probe D. State the verdict in the first paragraph.

**If probes A and B pass and C fails as required, continue to Task 2.**
**If A or B fails, or C succeeds: STOP and consult the human.** The Section 4 fallback (restricted token + Job Object, no AppContainer) becomes the design, and this plan needs rewriting from Task 3 onward — do not improvise it.

- [ ] **Step 5: Delete the throwaway and commit the note**

```bash
rm -rf /c/Temp/acl-spike
git add docs/superpowers/specs/2026-08-21-appcontainer-spike-findings.md
git commit -F - <<'EOF'
docs(specs): AppContainer ACL spike findings

Records the four probes and their measured outcomes. Throwaway probe code
was deleted; only the findings are kept.
EOF
```

---

### Task 2: SandboxPolicy replaces ExtensionManifest

Platform-independent, so it lands before any Windows work and the Windows runner is then written against the final interface. Windows behaviour is unchanged by this task — it still throws.

**Files:**

- Create: `packages/gateway/src/platform/sandbox/sandbox-policy.ts`
- Create: `packages/gateway/src/platform/sandbox/sandbox-policy.test.ts`
- Modify: `packages/gateway/src/platform/sandbox/sandbox-runner.ts`
- Modify: `packages/gateway/src/platform/sandbox/{linux,darwin,win32}.ts`
- Modify: `packages/gateway/src/platform/sandbox/{linux,darwin,win32}.test.ts`
- Modify: `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` + `.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `.claude/commands/nimbus-security-invariants.md`

**Interfaces:**

- Consumes: `SandboxPermissions` from `extensions/permissions-validator.ts`; `ExtensionManifest` from `extensions/manifest.ts`.
- Produces:
  - `interface SandboxPolicy { readonly id: string; readonly permissions: SandboxPermissions; readonly limits?: { readonly wallClockMs?: number } }`
  - `function policyFromManifest(manifest: ExtensionManifest): SandboxPolicy`
  - `SandboxSpawnOptions.policy: SandboxPolicy` (replacing `.manifest`)
  - Env var `NIMBUS_SANDBOX_POLICY_JSON` (replacing `NIMBUS_SANDBOX_MANIFEST_JSON`)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/platform/sandbox/sandbox-policy.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { policyFromManifest } from "./sandbox-policy.ts";

function manifest(over: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id: "com.nimbus.github",
    version: "1.0.0",
    permissions: {
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    },
    updateChannel: "stable",
    ...over,
  } as ExtensionManifest;
}

describe("policyFromManifest", () => {
  it("carries the manifest id through as the policy id", () => {
    expect(policyFromManifest(manifest()).id).toBe("com.nimbus.github");
  });

  it("carries permissions through unchanged", () => {
    expect(policyFromManifest(manifest()).permissions).toEqual({
      network: ["api.github.com"],
      filesystem: { read: ["/data"], write: [] },
    });
  });

  it("sets no limits — a connector is long-lived and is never wall-clock bounded", () => {
    expect(policyFromManifest(manifest()).limits).toBeUndefined();
  });

  it("does not leak non-permission manifest fields into the policy", () => {
    expect(Object.keys(policyFromManifest(manifest())).sort()).toEqual(["id", "permissions"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/platform/sandbox/sandbox-policy.test.ts`
Expected: FAIL — cannot resolve `./sandbox-policy.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/gateway/src/platform/sandbox/sandbox-policy.ts`:

```ts
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxPermissions } from "../../extensions/permissions-validator.ts";

/**
 * What a sandbox runner needs to know to confine a process.
 *
 * Deliberately NOT an `ExtensionManifest`: the runners only ever read `.permissions` and `.id`,
 * and a one-shot execution has no manifest to offer. Keeping the input this narrow is what lets
 * a per-execution capability set reach the same three runners a connector uses.
 */
export interface SandboxPolicy {
  /** Naming key. The Windows AppContainer profile name derives from it; Linux/macOS ignore it. */
  readonly id: string;
  readonly permissions: SandboxPermissions;
  /**
   * One-shot executions only. DECLARED BUT NOT ENFORCED by any runner in this release — the
   * execution surface adds enforcement (on Windows, a limit on the Job Object the helper already
   * assigns). Nothing may treat a set value here as a guarantee.
   */
  readonly limits?: { readonly wallClockMs?: number };
}

/** The single manifest -> policy derivation. `wrapServerSpec` is its only production caller. */
export function policyFromManifest(manifest: ExtensionManifest): SandboxPolicy {
  return { id: manifest.id, permissions: manifest.permissions };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/platform/sandbox/sandbox-policy.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Switch the runner interface**

In `sandbox-runner.ts`, replace the manifest field and drop the now-unused import:

```ts
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export interface SandboxSpawnOptions {
  policy: SandboxPolicy;
  env: Record<string, string>;
  cwd: string;
  stdio?: SpawnOptions["stdio"];
}
```

`SandboxRunner` itself is unchanged.

- [ ] **Step 6: Update the three runners**

Mechanical. In `linux.ts`: `decideNetworkMode(policy: SandboxPolicy, …)`, `buildBwrapArgv(policy: SandboxPolicy, …)`, and every `opts.manifest.permissions` → `opts.policy.permissions`. In `darwin.ts`: `SbplOpts.manifest` → `policy`, and `opts.manifest.permissions` → `opts.policy.permissions`. In `win32.ts`: `capabilitiesForManifest(manifest: ExtensionManifest)` → `capabilitiesForPolicy(policy: SandboxPolicy)`, `profileNameFor({ id })` unchanged (it already takes only `{ id: string }`). The throw stays for now.

Update the three `.test.ts` files to build a `SandboxPolicy` instead of a manifest.

- [ ] **Step 7: Rename the env contract**

`wrap-server-spec.ts`:

```ts
import { policyFromManifest } from "../../platform/sandbox/sandbox-policy.ts";

export function wrapServerSpec(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec {
  const { command, args } = selfSpawn("sandbox", [spec.command, ...spec.args]);
  return {
    command,
    args,
    env: {
      ...spec.env,
      NIMBUS_SANDBOX_POLICY_JSON: JSON.stringify(policyFromManifest(manifest)),
      NIMBUS_SANDBOX_CWD: cwd,
    },
  };
}
```

`sandbox-wrapper.ts`: read `NIMBUS_SANDBOX_POLICY_JSON`, parse it as `SandboxPolicy`, pass it as `policy`, and update the strip list at line 44 so the child still never sees either variable.

- [ ] **Step 8: Sweep every remaining reference**

The old name appears outside source. Grep the whole tree, not the files you touched:

```bash
grep -rn "NIMBUS_SANDBOX_MANIFEST_JSON" --include='*.ts' --include='*.md' . | grep -v node_modules
```

Expect hits in `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts` (7), `packages/gateway/src/connectors/lazy-mesh/{wrap-server-spec,phase3-config,chatops-bot-spawn}.test.ts`, `docs/SECURITY-INVARIANTS.md` (3, including the `D10` wiring-table row near line 837), and `.claude/commands/nimbus-security-invariants.md` (2). Fix all of them in this commit — the invariant docs move with the wiring, per the triple rule. The spec files under `docs/superpowers/specs/` are historical records of the pre-change state and are left alone.

- [ ] **Step 9: Verify**

```bash
bun test packages/gateway/src/platform/sandbox packages/gateway/src/connectors/lazy-mesh
bun test packages/gateway/test/unit/connectors/lazy-mesh
bun run preflight:fast
```

Expected: all pass. `preflight:fast` includes `audit:structure`, which enforces `D10`.

- [ ] **Step 10: Commit**

```bash
git add -u && git add packages/gateway/src/platform/sandbox/sandbox-policy.ts packages/gateway/src/platform/sandbox/sandbox-policy.test.ts
git commit -F - <<'EOF'
refactor(sandbox): runners take a SandboxPolicy, not an ExtensionManifest

The three runners only ever read .permissions and .id. Narrowing the input
lets a one-shot execution reach the same runners a connector uses, without
fabricating a manifest for something that is not an extension.

Renames the wrapper env contract to NIMBUS_SANDBOX_POLICY_JSON and updates
the I15/D10 documentation in the same commit.
EOF
```

---

### Task 3: The helper — probe and profile enumeration

Build the helper with its non-spawning modes first: they are independently testable on a Windows runner without touching AppContainer spawn, and Task 7's reaper needs them.

**Files:**

- Create: `packages/gateway/src-native/sandbox-helper-win32/main.c`
- Create: `packages/gateway/src-native/sandbox-helper-win32/README.md`
- Create: `scripts/build-sandbox-helper-win32.ps1`
- Modify: `package.json`
- Modify: `.github/workflows/_test-suite.yml`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `nimbus-sandbox-helper.exe` supporting
  - `--check-caps` → prints `OK` to stdout, exit 0; else a reason to stderr, exit 1
  - `--list-profiles` → prints each `nimbus-`-prefixed AppContainer moniker on its own line, exit 0
  - `--delete-profile <name>` → exit 0 on success or already-absent, 1 otherwise
  - Exit-code contract (below), consumed by Task 5.

**Exit-code contract.** The helper cannot `execv` — it must wait and propagate the child's code — so helper-originated failures share the code space with the child. Resolve it the way `sandbox-wrapper.ts` already does: **stderr is authoritative**, every helper-originated line is prefixed `nimbus-sandbox-helper:`, and codes are a hint. Reserved:

| Code | Meaning |
|---|---|
| 64 | usage error |
| 65 | AppContainer profile create/derive failed |
| 66 | ACL grant failed — path is on a filesystem without ACL support, or access denied |
| 67 | Job Object creation/assignment failed |
| 68 | `CreateProcessW` failed |
| other | the child's own exit code |

- [ ] **Step 1: Write the build script**

Create `scripts/build-sandbox-helper-win32.ps1`:

```powershell
#requires -Version 5.1
# Compiles the Windows sandbox helper with MSVC. No make on Windows runners, and no
# dependency on a Developer prompt: vswhere lives at a fixed path on every VS install.
$ErrorActionPreference = "Stop"

$src = Join-Path $PSScriptRoot "..\packages\gateway\src-native\sandbox-helper-win32"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere not found at $vswhere — is Visual Studio installed?" }

$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "No Visual Studio installation with the C++ toolset was found." }

$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

$out = Join-Path $src "nimbus-sandbox-helper.exe"
# /W4 /WX mirrors the Linux helper's -Wall -Wextra -Werror.
$cmd = "`"$vcvars`" && cl /nologo /W4 /WX /O2 /Fe:`"$out`" `"$(Join-Path $src 'main.c')`" /link userenv.lib advapi32.lib"
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "cl.exe failed with exit code $LASTEXITCODE" }
Write-Output "built $out"
```

Add to `package.json` scripts, beside the existing `build:sandbox-helper`:

```json
"build:sandbox-helper:win32": "pwsh -NoProfile -File scripts/build-sandbox-helper-win32.ps1"
```

- [ ] **Step 2: Write the helper's non-spawning modes**

Create `packages/gateway/src-native/sandbox-helper-win32/main.c`. Profile enumeration reads the per-user mappings key; deletion uses the documented API.

```c
/*
 * nimbus-sandbox-helper (Windows) — AppContainer helper for the extension sandbox (I15).
 *
 * UNPRIVILEGED, unlike the Linux helper: CreateAppContainerProfile is a per-user API and ACL
 * edits inside the user's own profile need no elevation. There is no install-time setcap
 * equivalent, and --check-caps probes that profile creation WORKS rather than that a
 * capability is HELD.
 *
 * stderr is the authoritative failure channel; see README.md for the exit-code contract.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <stdio.h>
#include <wchar.h>

#define PROFILE_PREFIX L"nimbus-"
#define MAPPINGS_KEY   L"Software\\Microsoft\\Windows\\CurrentVersion\\AppContainer\\Mappings"

static void err(const wchar_t *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fwprintf(stderr, L"nimbus-sandbox-helper: ");
    vfwprintf(stderr, fmt, ap);
    fwprintf(stderr, L"\n");
    va_end(ap);
}

/* Create the profile, or derive its SID if it already exists. Caller frees with FreeSid. */
static HRESULT profile_sid(const wchar_t *name, PSID *out) {
    HRESULT hr = CreateAppContainerProfile(name, name, L"Nimbus sandbox", NULL, 0, out);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(name, out);
    }
    return hr;
}

static int mode_check_caps(void) {
    PSID sid = NULL;
    HRESULT hr = profile_sid(L"nimbus-probe", &sid);
    if (FAILED(hr)) {
        err(L"cannot create an AppContainer profile: hr=0x%08lx", (unsigned long)hr);
        return 1;
    }
    FreeSid(sid);
    /* The probe profile is transient state; do not leave it behind. */
    DeleteAppContainerProfile(L"nimbus-probe");
    wprintf(L"OK\n");
    return 0;
}

static int mode_list_profiles(void) {
    HKEY key;
    LSTATUS rc = RegOpenKeyExW(HKEY_CURRENT_USER, MAPPINGS_KEY, 0, KEY_READ, &key);
    if (rc == ERROR_FILE_NOT_FOUND) return 0;   /* no profiles yet is not an error */
    if (rc != ERROR_SUCCESS) { err(L"RegOpenKeyExW: %ld", rc); return 1; }

    for (DWORD i = 0;; i++) {
        wchar_t sub[256];
        DWORD len = 256;
        rc = RegEnumKeyExW(key, i, sub, &len, NULL, NULL, NULL, NULL);
        if (rc == ERROR_NO_MORE_ITEMS) break;
        if (rc != ERROR_SUCCESS) { RegCloseKey(key); err(L"RegEnumKeyExW: %ld", rc); return 1; }

        wchar_t moniker[256];
        DWORD msz = sizeof(moniker);
        HKEY child;
        if (RegOpenKeyExW(key, sub, 0, KEY_READ, &child) != ERROR_SUCCESS) continue;
        rc = RegGetValueW(child, NULL, L"Moniker", RRF_RT_REG_SZ, NULL, moniker, &msz);
        RegCloseKey(child);
        if (rc != ERROR_SUCCESS) continue;
        if (wcsncmp(moniker, PROFILE_PREFIX, wcslen(PROFILE_PREFIX)) != 0) continue;
        wprintf(L"%s\n", moniker);
    }
    RegCloseKey(key);
    return 0;
}

static int mode_delete_profile(const wchar_t *name) {
    if (wcsncmp(name, PROFILE_PREFIX, wcslen(PROFILE_PREFIX)) != 0) {
        err(L"refusing to delete a profile outside the %s namespace: %s", PROFILE_PREFIX, name);
        return 64;
    }
    HRESULT hr = DeleteAppContainerProfile(name);
    if (SUCCEEDED(hr) || hr == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)) return 0;
    err(L"DeleteAppContainerProfile(%s): hr=0x%08lx", name, (unsigned long)hr);
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) { err(L"usage: --check-caps | --list-profiles | --delete-profile <name> | --profile <name> [...] -- <argv>"); return 64; }
    if (wcscmp(argv[1], L"--check-caps") == 0)     return mode_check_caps();
    if (wcscmp(argv[1], L"--list-profiles") == 0)  return mode_list_profiles();
    if (wcscmp(argv[1], L"--delete-profile") == 0) {
        if (argc < 3) { err(L"--delete-profile requires a name"); return 64; }
        return mode_delete_profile(argv[2]);
    }
    err(L"unknown mode: %s", argv[1]);
    return 64;
}
```

The `--profile … -- argv` spawn mode is Task 4; leaving it unimplemented here keeps this task independently reviewable.

- [ ] **Step 3: Build and exercise it by hand**

```powershell
bun run build:sandbox-helper:win32
$h = "packages/gateway/src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe"
& $h --check-caps          # expect: OK, exit 0
& $h --list-profiles       # expect: exit 0, no output on a clean machine
& $h --delete-profile foo  # expect: exit 64, refuses out-of-namespace
```

- [ ] **Step 4: Write the README**

Create `packages/gateway/src-native/sandbox-helper-win32/README.md` mirroring the Linux helper's: the four modes, the exit-code table above, and — stated plainly, because it is the load-bearing difference from Linux — that the helper is unprivileged and adds no install-time privilege step.

- [ ] **Step 5: Add the CI build step**

In `.github/workflows/_test-suite.yml`, beside the existing Linux sandbox-gate steps (around line 993), add:

```yaml
      - name: Build sandbox helper (Windows only, sandbox gate)
        if: runner.os == 'Windows' && matrix.gate.name == 'Sandbox'
        shell: pwsh
        run: bun run build:sandbox-helper:win32

      - name: Probe sandbox helper (Windows only, sandbox gate)
        if: runner.os == 'Windows' && matrix.gate.name == 'Sandbox'
        shell: pwsh
        run: |
          $h = "packages/gateway/src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe"
          $out = & $h --check-caps
          if ($LASTEXITCODE -ne 0 -or $out.Trim() -ne "OK") { throw "check-caps failed: $out" }
```

The Sandbox gate already runs on every OS in the matrix (`pal: true`), so no matrix change is needed.

- [ ] **Step 6: Add the build output to .gitignore**

```bash
echo "packages/gateway/src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe" >> .gitignore
echo "packages/gateway/src-native/sandbox-helper-win32/*.obj" >> .gitignore
```

Confirm the Linux helper's binary is ignored the same way; match its entry's style.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src-native/sandbox-helper-win32 scripts/build-sandbox-helper-win32.ps1 package.json .github/workflows/_test-suite.yml .gitignore
git commit -F - <<'EOF'
feat(sandbox): windows helper with probe and profile enumeration

Adds the unprivileged MSVC-built helper with its three non-spawning modes:
check-caps, list-profiles and delete-profile. The spawn path lands next.

Unlike the Linux helper this one needs no capability and no install-time
privilege step, so check-caps probes that profile creation works rather
than that a capability is held.
EOF
```

---

### Task 4: The helper — the spawn path

**Files:**

- Modify: `packages/gateway/src-native/sandbox-helper-win32/main.c`
- Modify: `packages/gateway/src-native/sandbox-helper-win32/README.md`

**Interfaces:**

- Consumes: `profile_sid()` and `err()` from Task 3.
- Produces: `--profile <name> --cwd <path> [--capability internetClient] [--grant-read <path>]… [--grant-write <path>]… -- <argv…>`, honouring the Task 3 exit-code contract. `--cwd` is mandatory and is NOT a policy grant — the helper treats it differently from `--grant-*` paths (see Step 2).

- [ ] **Step 1: Add the ACL grant helper**

Append to `main.c`:

```c
/*
 * Grant `sid` the requested rights on `path`. Returns 0, or 66 on failure — which is also what a
 * non-ACL filesystem (FAT32/exFAT, some network shares) produces, since SetNamedSecurityInfoW
 * cannot write a DACL there. The caller must not fall back to spawning unconfined: a policy path
 * the child cannot read is a failure to enforce, not a warning.
 *
 * `inherit` is load-bearing, not a detail. SUB_CONTAINERS_AND_OBJECTS_INHERIT propagates the ACE
 * to everything beneath `path`, which is right for a policy path (it means its subtree) and WRONG
 * for a directory we are only making listable on the way to somewhere else — an inheritable grant
 * on a working directory's parent would hand the container every sibling subtree under it.
 * Ancestors therefore pass NO_INHERITANCE. Task 6's out-of-policy-read test is the guard: its
 * `outside` directory is a sibling of the granted cwd, so an inheritable ancestor grant makes that
 * test fail. Do not widen the grant to make it pass.
 */
static int grant_path(const wchar_t *path, PSID sid, DWORD rights, DWORD inherit) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    DWORD rc = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                     DACL_SECURITY_INFORMATION, NULL, NULL, &old_acl, NULL, &sd);
    if (rc != ERROR_SUCCESS) { err(L"GetNamedSecurityInfoW(%s): %lu", path, rc); return 66; }

    EXPLICIT_ACCESS_W ea;
    ZeroMemory(&ea, sizeof(ea));
    ea.grfAccessPermissions = rights;
    ea.grfAccessMode        = GRANT_ACCESS;
    ea.grfInheritance       = inherit;
    ea.Trustee.TrusteeForm  = TRUSTEE_IS_SID;
    ea.Trustee.TrusteeType  = TRUSTEE_IS_GROUP;
    ea.Trustee.ptstrName    = (LPWSTR)sid;

    rc = SetEntriesInAclW(1, &ea, old_acl, &new_acl);
    if (rc != ERROR_SUCCESS) { LocalFree(sd); err(L"SetEntriesInAclW(%s): %lu", path, rc); return 66; }

    rc = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION, NULL, NULL, new_acl, NULL);
    LocalFree(new_acl);
    LocalFree(sd);
    if (rc != ERROR_SUCCESS) {
        err(L"SetNamedSecurityInfoW(%s): %lu — the path may be on a filesystem without ACL "
            L"support (FAT32/exFAT or a network share); the sandbox cannot enforce this policy",
            path, rc);
        return 66;
    }
    return 0;
}
```

- [ ] **Step 2: Add the cwd ancestor walk**

> **SUPERSEDED.** `grant_cwd_ancestors()` and its `NO_INHERITANCE` ancestor grants, as prescribed
> below, were built and then deliberately deleted mid-branch: modifying the DACL of a directory
> the helper does not own is itself an unwanted, persistent side effect, and — independently — the
> walk was measured to hang indefinitely on at least one production-shaped tree. The shipped grant
> policy is exactly the leaf (`--cwd`) plus explicit `--grant-read`/`--grant-write` paths, with
> **no** ancestor grant of any kind; a `bun <script>` child still cannot start under a
> profile-nested cwd, a known, documented limitation rather than something this walk was fixing.
> See `main.c`'s `grant_path()` (the "used to be a third category" comment) and
> `packages/gateway/src-native/sandbox-helper-win32/README.md` ("Consequence, measured rather than
> assumed") for the current, load-bearing design. The rest of this section is retained as a
> record of what was tried, not as the shipped mechanism.

Measured in the Task 1 spike, not assumed: a Bun child could not load a script from a leaf-only
grant, failing with `CouldntReadCurrentDirectory`. Bun walks **upward** from the working directory
enumerating each ancestor for `package.json` / `bunfig.toml`, which needs list rights on each
level — traverse alone is not enough — and it needs write on the leaf for its own housekeeping.

Grant each ancestor `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE` with **`NO_INHERITANCE`**, so the
directory itself becomes listable while its other children stay unreachable. Stop below the volume
root and never grant the root: `C:\Windows` and `C:\Windows\System32` already carry
`ALL APPLICATION PACKAGES` natively, and the spike needed nothing above its own chain.

```c
/* Make every ancestor of `dir` listable (that directory ONLY — see grant_path on inheritance),
 * so Bun's upward package.json walk can enumerate each level. Stops below the volume root. */
static int grant_cwd_ancestors(const wchar_t *dir, PSID sid) {
    wchar_t path[MAX_PATH];
    if (wcslen(dir) >= MAX_PATH) { err(L"cwd path too long: %s", dir); return 64; }
    wcscpy_s(path, MAX_PATH, dir);

    for (;;) {
        wchar_t *slash = wcsrchr(path, L'\\');
        if (slash == NULL) break;
        *slash = L'\0';
        /* "C:" — the volume root. Stop; never grant it. */
        if (wcschr(path, L'\\') == NULL) break;
        int rc = grant_path(path, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, NO_INHERITANCE);
        if (rc != 0) return rc;
    }
    return 0;
}
```

- [ ] **Step 3: Add the argv quoter**

The child's command line has to be rebuilt from `argv`, and Windows quoting is not "wrap it in
quotes". Both failure cases are reachable here, not hypothetical:

- **An argument containing a double quote.** `connector.addMcp` stores a user-supplied
  `args_json` string array (`packages/gateway/src/connectors/lazy-mesh/user-mcp-store.ts`) that
  becomes the child argv verbatim. A server registered with a JSON config argument carries `"`.
- **An argument ending in a backslash.** Any Windows directory path. `"C:\dir\"` ends with an
  escaped quote, so the closing quote is consumed and the next argument is swallowed into this one.

Implement the inverse of `CommandLineToArgvW`. Append with a cursor rather than repeated
`wcscat_s`, which rescans from the start each call and turns this into a quadratic walk over a
32 KB buffer:

```c
/*
 * Append `arg` to `dst` using the quoting rules CommandLineToArgvW and the MSVC runtime startup
 * code invert. Returns 0, or 64 if the buffer would overflow.
 *
 * Rules: a run of backslashes is literal UNLESS it precedes a double quote or the closing quote,
 * in which case each backslash doubles; a literal double quote is escaped as \".
 */
static int append_quoted(wchar_t *dst, size_t cap, size_t *len, const wchar_t *arg) {
#define PUT(ch) do { if (*len + 2 > cap) return 64; dst[(*len)++] = (ch); dst[*len] = L'\0'; } while (0)
    if (*arg != L'\0' && wcspbrk(arg, L" \t\n\v\"") == NULL) {
        for (const wchar_t *p = arg; *p; p++) PUT(*p);
        return 0;
    }
    PUT(L'"');
    for (const wchar_t *p = arg;; p++) {
        unsigned nbs = 0;
        while (*p == L'\\') { nbs++; p++; }
        if (*p == L'\0') {
            /* Trailing backslashes precede the closing quote, so they double. */
            for (unsigned k = 0; k < nbs * 2; k++) PUT(L'\\');
            break;
        }
        if (*p == L'"') {
            for (unsigned k = 0; k < nbs * 2 + 1; k++) PUT(L'\\');
        } else {
            for (unsigned k = 0; k < nbs; k++) PUT(L'\\');
        }
        PUT(*p);
    }
    PUT(L'"');
    return 0;
#undef PUT
}
```

- [ ] **Step 4: Add the spawn mode**

```c
static int mode_spawn(int argc, wchar_t **argv) {
    const wchar_t *profile = NULL;
    const wchar_t *cwd = NULL;
    BOOL want_net = FALSE;
    const wchar_t *reads[64];  int nread = 0;
    const wchar_t *writes[64]; int nwrite = 0;
    int i = 1;

    for (; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) { i++; break; }
        if (wcscmp(argv[i], L"--profile") == 0 && i + 1 < argc)          { profile = argv[++i]; }
        else if (wcscmp(argv[i], L"--cwd") == 0 && i + 1 < argc)         { cwd = argv[++i]; }
        else if (wcscmp(argv[i], L"--capability") == 0 && i + 1 < argc)  { i++; if (wcscmp(argv[i], L"internetClient") == 0) want_net = TRUE; }
        else if (wcscmp(argv[i], L"--grant-read") == 0 && i + 1 < argc)  { if (nread  >= 64) { err(L"too many --grant-read");  return 64; } reads[nread++]   = argv[++i]; }
        else if (wcscmp(argv[i], L"--grant-write") == 0 && i + 1 < argc) { if (nwrite >= 64) { err(L"too many --grant-write"); return 64; } writes[nwrite++] = argv[++i]; }
        else { err(L"unexpected arg: %s", argv[i]); return 64; }
    }
    if (profile == NULL) { err(L"--profile is required"); return 64; }
    if (cwd == NULL)     { err(L"--cwd is required"); return 64; }
    if (i >= argc)       { err(L"expected -- followed by child argv"); return 64; }

    PSID sid = NULL;
    HRESULT hr = profile_sid(profile, &sid);
    if (FAILED(hr)) { err(L"profile %s: hr=0x%08lx", profile, (unsigned long)hr); return 65; }

    /* The working directory: Modify, inheritable — the child works inside it. */
    int rc = grant_path(cwd, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
    if (rc != 0) { FreeSid(sid); return rc; }
    /* Its ancestors: listable only, NOT inheritable. See grant_cwd_ancestors. */
    rc = grant_cwd_ancestors(cwd, sid);
    if (rc != 0) { FreeSid(sid); return rc; }

    /* Policy paths are subtree grants, so they inherit. Their ancestors get NOTHING: Windows
     * bypasses traverse checking by default, so a known full path opens without listing rights on
     * the way down — the spike's failure was on ENUMERATION, not traversal. If a connector turns
     * out to need more than this, widen it deliberately and record why; do not widen on a hunch. */
    for (int k = 0; k < nread; k++) {
        rc = grant_path(reads[k], sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
        if (rc != 0) { FreeSid(sid); return rc; }
    }
    for (int k = 0; k < nwrite; k++) {
        rc = grant_path(writes[k], sid,
                        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
        if (rc != 0) { FreeSid(sid); return rc; }
    }

    /* Job Object: the analogue of bwrap's --die-with-parent. When our handle closes — including
     * on a crash — the OS terminates the child rather than orphaning it. */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job == NULL) { FreeSid(sid); err(L"CreateJobObjectW: %lu", GetLastError()); return 67; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl;
    ZeroMemory(&jl, sizeof(jl));
    jl.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jl, sizeof(jl))) {
        CloseHandle(job); FreeSid(sid);
        err(L"SetInformationJobObject: %lu", GetLastError());
        return 67;
    }

    SID_AND_ATTRIBUTES cap;
    SECURITY_CAPABILITIES caps;
    ZeroMemory(&caps, sizeof(caps));
    caps.AppContainerSid = sid;
    if (want_net) {
        PSID net = NULL;
        SID_IDENTIFIER_AUTHORITY auth = SECURITY_APP_PACKAGE_AUTHORITY;
        if (!AllocateAndInitializeSid(&auth, SECURITY_BUILTIN_CAPABILITY_RID_COUNT,
                                      SECURITY_CAPABILITY_BASE_RID,
                                      SECURITY_CAPABILITY_INTERNET_CLIENT,
                                      0, 0, 0, 0, 0, 0, &net)) {
            CloseHandle(job); FreeSid(sid);
            err(L"AllocateAndInitializeSid(internetClient): %lu", GetLastError());
            return 65;
        }
        cap.Sid = net;
        cap.Attributes = SE_GROUP_ENABLED;
        caps.Capabilities = &cap;
        caps.CapabilityCount = 1;
    }

    SIZE_T sz = 0;
    InitializeProcThreadAttributeList(NULL, 1, 0, &sz);
    LPPROC_THREAD_ATTRIBUTE_LIST attrs =
        (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, sz);
    if (attrs == NULL || !InitializeProcThreadAttributeList(attrs, 1, 0, &sz) ||
        !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &caps, sizeof(caps), NULL, NULL)) {
        DWORD e = GetLastError();
        if (attrs != NULL) HeapFree(GetProcessHeap(), 0, attrs);
        CloseHandle(job); FreeSid(sid);
        err(L"proc-thread attribute list: %lu", e);
        return 68;
    }

    /* Rebuild a command line from the child argv. See append_quoted — naive quoting corrupts
     * any argument containing a double quote or ending in a backslash, and both are reachable. */
    wchar_t cmdline[32768];
    size_t clen = 0;
    cmdline[0] = L'\0';
    for (int k = i; k < argc; k++) {
        if (k > i) { if (clen + 2 > 32768) { err(L"child command line too long"); return 64; }
                     cmdline[clen++] = L' '; cmdline[clen] = L'\0'; }
        if (append_quoted(cmdline, 32768, &clen, argv[k]) != 0) {
            err(L"child command line too long");
            return 64;
        }
    }

    STARTUPINFOEXW si;
    ZeroMemory(&si, sizeof(si));
    si.StartupInfo.cb = sizeof(si);
    si.StartupInfo.dwFlags    = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput  = GetStdHandle(STD_INPUT_HANDLE);
    si.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.StartupInfo.hStdError  = GetStdHandle(STD_ERROR_HANDLE);
    si.lpAttributeList = attrs;

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmdline, NULL, NULL, TRUE,
                        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                        NULL, cwd, &si.StartupInfo, &pi)) {
        DWORD e = GetLastError();
        DeleteProcThreadAttributeList(attrs);
        HeapFree(GetProcessHeap(), 0, attrs);
        CloseHandle(job); FreeSid(sid);
        err(L"CreateProcessW: %lu", e);
        return 68;
    }
    /* Assign BEFORE resuming, so the child can never run outside the job. */
    if (!AssignProcessToJobObject(job, pi.hProcess)) {
        DWORD e = GetLastError();
        TerminateProcess(pi.hProcess, 1);
        /* Close every failure-path handle explicitly. The OS would reclaim them at exit, but a
         * self-contained failure path is what lets this function be reused or moved later. */
        DeleteProcThreadAttributeList(attrs);
        HeapFree(GetProcessHeap(), 0, attrs);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        CloseHandle(job);
        FreeSid(sid);
        err(L"AssignProcessToJobObject: %lu", e);
        return 67;
    }
    ResumeThread(pi.hThread);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);

    DeleteProcThreadAttributeList(attrs);
    HeapFree(GetProcessHeap(), 0, attrs);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    FreeSid(sid);
    /* Do NOT close `job` before the wait completes — closing it kills the child. */
    CloseHandle(job);
    return (int)code;
}
```

Wire it into `wmain`: if `argv[1]` is `--profile`, call `mode_spawn(argc, argv)`.

- [ ] **Step 5: Build and exercise it by hand**

```powershell
bun run build:sandbox-helper:win32
$h = "packages/gateway/src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe"
$w = "$env:TEMP\nimbus-helper-check"
mkdir $w
Copy-Item (Get-Command bun).Source $w\bun.exe
Set-Content $w\hello.js 'process.stdout.write("hello\n")'

# A real Bun child loading a script file — the case the Task 1 spike found a leaf-only
# grant could NOT satisfy. If this fails with CouldntReadCurrentDirectory, the ancestor
# walk is wrong.
& $h --profile nimbus-ext-com.nimbus.test --cwd $w -- $w\bun.exe $w\hello.js
# expect: hello, exit 0

& $h --profile nimbus-ext-com.nimbus.test --cwd $w -- cmd /c exit 42
# expect: exit 42 — the CHILD's code, propagated

# Sibling isolation: an ancestor of the cwd is granted, so its OTHER children must stay
# unreachable. A non-zero exit here is the pass.
mkdir $env:TEMP\nimbus-helper-secret
Set-Content $env:TEMP\nimbus-helper-secret\s.txt 'secret'
& $h --profile nimbus-ext-com.nimbus.test --cwd $w `
     -- $w\bun.exe -e "require('fs').readFileSync('$env:TEMP\nimbus-helper-secret\s.txt')"
# expect: NON-ZERO exit. A zero exit means an ancestor grant is inheriting into siblings.

# Ruling 1 substitute for the non-NTFS case: a directory whose DACL we cannot rewrite.
# This proves exit 66 and the stderr reason; it does NOT exercise the non-NTFS trigger.
& $h --profile nimbus-ext-com.nimbus.test --cwd $w --grant-read C:\Windows\System32\config `
     -- cmd /c echo x
# expect: exit 66 with the ACL-grant-failed message on stderr

# Argv fidelity — the two cases naive quoting corrupts. Both must round-trip verbatim.
& $h --profile nimbus-ext-com.nimbus.test --cwd $w `
     -- $w\bun.exe -e "console.log(JSON.stringify(process.argv.slice(2)))" `
        '{"k":"v"}' 'C:\dir\' 'plain'
# expect exactly: ["{\"k\":\"v\"}","C:\\dir\\","plain"]
```

- [ ] **Step 6: Update the README** with the spawn mode, the per-level ACL-grant semantics
      (inheritable on the leaf and on policy paths, NOT inheritable on cwd ancestors, and why),
      and the argv quoting rules.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src-native/sandbox-helper-win32
git commit -F - <<'EOF'
feat(sandbox): windows helper spawn path inside an AppContainer

Grants the container SID the ACEs the policy declares, assigns a Job Object
with KILL_ON_JOB_CLOSE so a crashed parent cannot orphan the child, and
spawns suspended-then-assigned so the child never runs outside the job.

A path on a filesystem without ACL support fails closed with a dedicated
exit code and a stderr reason, rather than spawning a child that silently
cannot read what the policy granted it.

Child argv is rebuilt with the quoting rules CommandLineToArgvW inverts,
not by wrapping each argument in quotes. A user-registered MCP server's
args_json is arbitrary user input, so an argument carrying a double quote
is reachable, and any Windows path can end in a backslash.
EOF
```

---

### Task 5: The win32 runner stops throwing

**Files:**

- Create: `packages/gateway/src/platform/sandbox/win32-argv.ts`
- Create: `packages/gateway/src/platform/sandbox/win32-argv.test.ts`
- Modify: `packages/gateway/src/platform/sandbox/win32.ts`
- Modify: `packages/gateway/src/platform/sandbox/win32.test.ts`

**Interfaces:**

- Consumes: `SandboxPolicy` (Task 2); the helper CLI (Tasks 3–4).
- Produces: `function buildHelperArgv(policy: SandboxPolicy, opts: { cwd: string }): string[]`; a `createWin32SandboxRunner()` whose `spawn` returns a real `ChildProcess`.

- [ ] **Step 1: Write the failing test**

Create `win32-argv.test.ts`. Note it carries **no** platform skip — the derivation is pure, and the comment at the top of `win32.test.ts` records why gating these files made them read 0% on the CI-Linux-authoritative coverage run.

```ts
import { describe, expect, it } from "bun:test";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { buildHelperArgv } from "./win32-argv.ts";

function policy(over: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy {
  return {
    id: "com.nimbus.github",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...over },
  };
}

describe("buildHelperArgv", () => {
  it("names the profile from the policy id", () => {
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv.slice(0, 2)).toEqual(["--profile", "nimbus-ext-com.nimbus.github"]);
  });

  it("passes the cwd under its own flag, not as a policy grant", () => {
    // The helper treats the cwd differently from a policy path: Modify + inheritable on the
    // leaf, listable-but-NOT-inheritable on each ancestor, so Bun's upward package.json walk
    // works without exposing sibling subtrees. That split is only possible if it knows which
    // path is the cwd, so it travels under --cwd rather than folded into --grant-write.
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv).toEqual(expect.arrayContaining(["--cwd", "C:\\data"]));
    expect(argv).not.toContain("--grant-write");
  });

  it("requests internetClient only when the policy declares a network host", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" })).not.toContain("--capability");
    const withNet = buildHelperArgv(policy({ network: ["api.github.com"] }), { cwd: "C:\\d" });
    expect(withNet).toContain("--capability");
    expect(withNet).toContain("internetClient");
  });

  it("grants internetClient exactly once regardless of host count", () => {
    const argv = buildHelperArgv(
      policy({ network: ["api.github.com", "gitlab.com", "slack.com"] }),
      { cwd: "C:\\d" },
    );
    expect(argv.filter((a) => a === "internetClient")).toHaveLength(1);
  });

  it("maps filesystem read and write permissions to their own grant flags", () => {
    const argv = buildHelperArgv(
      policy({ filesystem: { read: ["C:\\ro"], write: ["C:\\rw"] } }),
      { cwd: "C:\\d" },
    );
    expect(argv).toEqual(expect.arrayContaining(["--grant-read", "C:\\ro"]));
    expect(argv).toEqual(expect.arrayContaining(["--grant-write", "C:\\rw"]));
  });

  it("terminates the helper flags with a bare -- so child argv cannot be read as flags", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" }).at(-1)).toBe("--");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/platform/sandbox/win32-argv.test.ts`
Expected: FAIL — cannot resolve `./win32-argv.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import type { SandboxPolicy } from "./sandbox-policy.ts";

/** AppContainer profile name for a policy. The `nimbus-` prefix is what the reaper matches on. */
export function profileNameFor(policy: { id: string }): string {
  return `nimbus-ext-${policy.id}`;
}

/**
 * Helper argv for one spawn. Pure derivation — no OS calls — so it is testable on every platform
 * and stays visible to the CI-Linux coverage run.
 *
 * Trailing `--` is load-bearing: without it a child argument beginning with `--grant-read` would
 * be parsed by the helper as a flag.
 */
export function buildHelperArgv(policy: SandboxPolicy, opts: { cwd: string }): string[] {
  const argv: string[] = ["--profile", profileNameFor(policy), "--cwd", opts.cwd];
  if (policy.permissions.network.length > 0) {
    argv.push("--capability", "internetClient");
  }
  for (const p of policy.permissions.filesystem.read) {
    argv.push("--grant-read", p);
  }
  for (const p of policy.permissions.filesystem.write) {
    argv.push("--grant-write", p);
  }
  argv.push("--");
  return argv;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/platform/sandbox/win32-argv.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Rewrite the runner**

Replace `win32.ts` wholesale. It keeps the probe-once shape `linux.ts` uses:

```ts
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";
import { buildHelperArgv } from "./win32-argv.ts";

export { profileNameFor } from "./win32-argv.ts";

function defaultHelperPath(): string {
  return join(dirname(process.execPath), "nimbus-sandbox-helper.exe");
}

export function helperPath(): string {
  return process.env["NIMBUS_SANDBOX_HELPER_PATH"] ?? defaultHelperPath();
}

interface HelperState {
  available: boolean;
  reason: string | null;
}

function probeHelper(path: string): HelperState {
  if (!existsSync(path)) {
    return { available: false, reason: `nimbus-sandbox-helper.exe not found at ${path}` };
  }
  try {
    const r = spawnSync(path, ["--check-caps"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "OK") return { available: true, reason: null };
    const stderr = (r.stderr ?? "").trim();
    return {
      available: false,
      reason: `nimbus-sandbox-helper.exe cannot create an AppContainer profile: ${
        stderr === "" ? "<no stderr>" : stderr
      }`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { available: false, reason: `nimbus-sandbox-helper.exe probe failed: ${msg}` };
  }
}

export function createWin32SandboxRunner(): SandboxRunner {
  const path = helperPath();
  const helper = probeHelper(path);

  return {
    platform: "win32",
    spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
      // I15 fail-closed: no helper means no enforceable confinement, so refuse rather than
      // spawn unconfined. This is the same posture the pre-implementation stub had; what
      // changes is that it is now conditional on a measured fact rather than permanent.
      if (!helper.available) {
        throw new Error(
          `refusing to spawn unsandboxed on Windows: ${helper.reason ?? "helper unavailable"}`,
        );
      }
      const argv = [...buildHelperArgv(opts.policy, { cwd: opts.cwd }), cmd, ...args];
      return spawn(path, argv, { env: opts.env, cwd: opts.cwd, stdio: opts.stdio });
    },
    isFullyActive(): boolean {
      return helper.available;
    },
    degradedReason(): string | null {
      if (!helper.available) return helper.reason;
      // Per-host network filtering would need a WFP callout driver with kernel-mode signing.
      // Documented and accepted; see docs/sandbox.md#platform-asymmetry.
      return "Windows: per-host network filtering is all-or-nothing (AppContainer internetClient); see docs/sandbox.md#platform-asymmetry";
    },
  };
}

export function capabilitiesForPolicy(policy: SandboxPolicy): string[] {
  return policy.permissions.network.length > 0 ? ["internetClient"] : [];
}
```

- [ ] **Step 6: Invert the stub test**

In `win32.test.ts`, delete the `"fails closed: spawn throws instead of running the extension unsandboxed"` case — it asserted the defect as intended behaviour — and replace it with a case that proves the fail-closed path is now *conditional*:

```ts
it("still fails closed when the helper is absent — never spawns unconfined", () => {
  const prev = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = join(TMP_ROOT, "definitely-not-here.exe");
  try {
    const runner = createWin32SandboxRunner();
    expect(runner.isFullyActive()).toBe(false);
    expect(runner.degradedReason()).toContain("not found");
    expect(() =>
      runner.spawn("bun", ["x.js"], {
        policy: { id: "com.nimbus.test", permissions: { network: [], filesystem: { read: [], write: [] } } },
        env: {},
        cwd: join(TMP_ROOT, "ext-cwd"),
      }),
    ).toThrow(/refusing to spawn unsandboxed/);
  } finally {
    if (prev === undefined) delete process.env["NIMBUS_SANDBOX_HELPER_PATH"];
    else process.env["NIMBUS_SANDBOX_HELPER_PATH"] = prev;
  }
});
```

Also update the `capabilitiesForManifest` cases to `capabilitiesForPolicy`.

- [ ] **Step 7: Verify**

```bash
bun test packages/gateway/src/platform/sandbox
bun run preflight:fast
```

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/platform/sandbox
git commit -F - <<'EOF'
feat(sandbox): the windows runner spawns through the helper

Replaces the permanent throw with a probe-once runner in the shape the
Linux runner already uses. Fail-closed is preserved and becomes conditional
on a measured fact: with no working helper it still refuses rather than
spawning unconfined.

Splits the argv derivation into win32-argv.ts so it is testable on Linux
and stays visible to the CI-Linux-authoritative coverage run.
EOF
```

---

### Task 6: The cross-platform spawn test, and red-proving it

The deliverable this whole plan turns on. Nothing in CI currently spawns through `__nimbus-sandbox` on any OS but Linux, which is what let the defect survive a green three-OS matrix.

**Files:**

- Create: `packages/gateway/test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts`

**Interfaces:**

- Consumes: the `__nimbus-sandbox` role of `packages/gateway/src/index.ts`; `NIMBUS_SANDBOX_POLICY_JSON` (Task 2).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the test**

```ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { SandboxPolicy } from "../../../../src/platform/sandbox/sandbox-policy.ts";

const GATEWAY_ENTRY = resolve(import.meta.dir, "../../../../src/index.ts");

/** On Windows the helper must exist for the spawn to be permitted at all (I15 fail-closed). */
const WIN_HELPER = resolve(
  import.meta.dir,
  "../../../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);
const LINUX_HELPER_DEP = process.platform !== "linux" || existsSync("/usr/bin/bwrap");
const READY = process.platform === "win32" ? existsSync(WIN_HELPER) : LINUX_HELPER_DEP;

function runThroughWrapper(
  policy: SandboxPolicy,
  cwd: string,
  argv: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", ...argv], {
    encoding: "utf8",
    env: {
      ...process.env,
      NIMBUS_SANDBOX_POLICY_JSON: JSON.stringify(policy),
      NIMBUS_SANDBOX_CWD: cwd,
      ...(process.platform === "win32" ? { NIMBUS_SANDBOX_HELPER_PATH: WIN_HELPER } : {}),
    },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe.skipIf(!READY)("sandbox wrapper: real spawn on every platform", () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-wrapper-spawn-"));
  const work = join(root, "work");
  const outside = join(root, "outside");

  function policy(): SandboxPolicy {
    return { id: "com.nimbus.wrapper-test", permissions: { network: [], filesystem: { read: [work], write: [work] } } };
  }

  it("round-trips stdout through the sandbox — the property MCP stdio depends on", () => {
    const script = join(work, "hello.js");
    writeFileSync(script, 'process.stdout.write("hello-from-sandbox")');
    const r = runThroughWrapper(policy(), work, [process.execPath, script]);
    expect(r.stdout).toContain("hello-from-sandbox");
    expect(r.status).toBe(0);
  });

  it("propagates the child's exit code", () => {
    const script = join(work, "exit7.js");
    writeFileSync(script, "process.exit(7)");
    expect(runThroughWrapper(policy(), work, [process.execPath, script]).status).toBe(7);
  });

  it("refuses a path the policy does not grant", () => {
    // This is what makes it a SANDBOX test rather than a spawn test: without it the whole
    // suite would pass against an unsandboxed spawn.
    const script = join(work, "peek.js");
    writeFileSync(script, `require("fs").readFileSync(${JSON.stringify(join(outside, "secret.txt"))})`);
    const r = runThroughWrapper(policy(), work, [process.execPath, script]);
    expect(r.status).not.toBe(0);
  });

  it("passes child argv through verbatim, quotes and trailing backslashes included", () => {
    // The Windows helper rebuilds a command line from argv, and naive quoting corrupts both of
    // these. Reachable, not hypothetical: connector.addMcp stores a user-supplied args_json that
    // becomes the child argv. On Linux/macOS this passes trivially — that is the point, it pins
    // the property on every platform rather than only where it is easy to break.
    const script = join(work, "argv.js");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const args = ['{"k":"v"}', "C:\\dir\\", "a b", "plain"];
    const r = runThroughWrapper(policy(), work, [process.execPath, script, ...args]);
    expect(JSON.parse(r.stdout) as string[]).toEqual(args);
  });

  it("rejects a spawn with no policy at all", () => {
    const r = spawnSync(process.execPath, [GATEWAY_ENTRY, "__nimbus-sandbox", "cmd"], {
      encoding: "utf8",
      env: { ...process.env, NIMBUS_SANDBOX_CWD: work },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NIMBUS_SANDBOX_POLICY_JSON");
  });
});
```

Before the assertions run, create `work` and `outside` and write `outside/secret.txt`; remove `root` in an `afterAll`, matching the temp-dir hygiene the existing sandbox tests follow (see issues #972/#973 on leaked temp dirs).

- [ ] **Step 2: Run it on Windows**

Run: `bun test packages/gateway/test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 3: Red-prove it**

A green suite proves nothing here. Revert the runner and confirm red:

```bash
git stash push -u -m "redprove-win32-sandbox"
git stash list --format='%H %gs'   # capture YOUR entry's SHA
```

Then hand-edit `win32.ts`'s `spawn` to `throw new Error("stub")` as its first statement, **read the file back to confirm the edit applied** — a revert that silently fails to apply looks green — and re-run the test.

Expected: FAIL on the first three cases.

Restore with `git stash apply <sha>` (never bare `pop` — the stash stack is shared with other worktrees), then drop the entry by re-finding it by tag.

- [ ] **Step 4: Confirm it runs on Linux and macOS too**

The test must not be Windows-only, or it recreates the hole it exists to close. On Linux, `bwrap` must be installed (`scripts/linux/install-sandbox-deps.sh`). On macOS `sandbox-exec` is present by default. Run the suite on at least Linux via `bun run verify:docker` and confirm the four cases execute rather than skip — a skipped suite reports green.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts
git commit -F - <<'EOF'
test(sandbox): spawn through the wrapper for real on all three platforms

Nothing in CI exercised the __nimbus-sandbox role outside the Linux strace
test, which is why a broken Windows spawn path survived a green three-OS
matrix. Asserts stdout round-trip, exit-code propagation, and refusal of an
out-of-policy path — the last being what makes it a sandbox test rather
than a spawn test.

Red-proven by reverting the win32 runner to its throwing stub.
EOF
```

---

### Task 7: Wire the orphan reaper, and correct the docs that claim it runs

`reapOrphanedAppContainers` has existed with zero production callers. Two documents describe it as running. Shipping real profile creation without it manufactures the registry leak the spec's Section 1 warns about.

**Files:**

- Create: `packages/gateway/src/platform/sandbox/win32-reap.ts`
- Create: `packages/gateway/src/platform/sandbox/win32-reap.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (at the `createSandboxRunner()` call, line ~2256)
- Modify: `docs/architecture.md` (threat-table row, line ~1795)
- Modify: `.claude/commands/nimbus-file-map.md` (line ~47)

**Interfaces:**

- Consumes: `reapOrphanedAppContainers` from `orphan-reap.ts`; `helperPath()` from `win32.ts` (Task 5); `FIRST_PARTY_MANIFESTS`.
- Produces: `function reapAppContainersAtBoot(deps: { db: Database; logger: Logger }): Promise<readonly string[]>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "bun:test";

import { liveExtensionIds, reapWith } from "./win32-reap.ts";

describe("liveExtensionIds", () => {
  it("includes every first-party manifest id", () => {
    const ids = liveExtensionIds({ query: () => ({ all: () => [] }) } as never);
    expect(ids.has("com.nimbus.github")).toBe(true);
  });

  it("includes installed extension ids from the extension table", () => {
    const db = { query: () => ({ all: () => [{ id: "com.acme.custom" }] }) };
    expect(liveExtensionIds(db as never).has("com.acme.custom")).toBe(true);
  });
});

describe("reapWith", () => {
  it("deletes a nimbus profile whose extension is gone", async () => {
    const deleted: string[] = [];
    const reaped = await reapWith({
      enumProfiles: async () => ["nimbus-ext-com.acme.gone", "nimbus-ext-com.nimbus.github"],
      deleteProfile: async (n) => { deleted.push(n); },
      liveExtensionIds: new Set(["com.nimbus.github"]),
    });
    expect(deleted).toEqual(["nimbus-ext-com.acme.gone"]);
    expect(reaped).toEqual(["nimbus-ext-com.acme.gone"]);
  });

  it("leaves a profile outside the nimbus-ext namespace alone", async () => {
    const deleted: string[] = [];
    await reapWith({
      enumProfiles: async () => ["some-other-app"],
      deleteProfile: async (n) => { deleted.push(n); },
      liveExtensionIds: new Set(),
    });
    expect(deleted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/platform/sandbox/win32-reap.test.ts`
Expected: FAIL — cannot resolve `./win32-reap.ts`.

- [ ] **Step 3: Write the implementation**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { FIRST_PARTY_MANIFESTS } from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { reapOrphanedAppContainers, type ReapOpts } from "./orphan-reap.ts";
import { helperPath } from "./win32.ts";

/** Every extension id that may legitimately own an AppContainer profile right now. */
export function liveExtensionIds(db: Database): Set<string> {
  const ids = new Set<string>();
  for (const m of Object.values(FIRST_PARTY_MANIFESTS)) ids.add(m.id);
  const rows = db.query("SELECT id FROM extension").all() as ReadonlyArray<{ id: string }>;
  for (const r of rows) ids.add(r.id);
  return ids;
}

/** Injectable seam so the reap logic is testable without Windows. */
export function reapWith(opts: ReapOpts): Promise<string[]> {
  return reapOrphanedAppContainers(opts);
}

const run = promisify(execFile);

/**
 * Boot-time reap. Windows-only and best-effort: a failure here leaks registry state, which is
 * untidy, and must never prevent the gateway from starting.
 *
 * Every helper invocation is ASYNCHRONOUS on purpose. `spawnSync` would block the single JS
 * thread for the duration of each call, and the caller's `void` does not change that — an async
 * function's body runs synchronously up to its first real await, so a sync spawn inside it stalls
 * boot exactly as much as awaiting would. With `execFile` the first await yields immediately and
 * the reap genuinely proceeds in the background.
 */
export async function reapAppContainersAtBoot(deps: {
  db: Database;
  logger: Logger;
}): Promise<readonly string[]> {
  if (process.platform !== "win32") return [];
  const path = helperPath();
  try {
    const reaped = await reapWith({
      enumProfiles: async () => {
        try {
          const { stdout } = await run(path, ["--list-profiles"], { encoding: "utf8" });
          return stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
        } catch {
          return [];
        }
      },
      deleteProfile: async (name: string) => {
        try {
          await run(path, ["--delete-profile", name], { encoding: "utf8" });
        } catch {
          // Best effort: one profile that will not delete must not abort the sweep.
        }
      },
      liveExtensionIds: liveExtensionIds(deps.db),
    });
    if (reaped.length > 0) deps.logger.info({ reaped }, "sandbox: reaped orphaned AppContainers");
    return reaped;
  } catch (e) {
    deps.logger.warn({ err: e }, "sandbox: AppContainer reap failed (non-fatal)");
    return [];
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test packages/gateway/src/platform/sandbox/win32-reap.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire it at boot**

In `assemble.ts`, `db` is opened immediately after `createSandboxRunner()`. Add the call after `appendBootMarkerOrWarn(...)`, where both `db` and `syncLogger` exist:

```ts
// The AppContainer profiles the Windows sandbox creates are per-user registry state. Reap the
// ones whose extension is gone, or they accumulate across every install/uninstall cycle and
// leave orphaned SIDs on paths they were granted. Non-fatal by construction: see the function.
void reapAppContainersAtBoot({ db, logger: syncLogger });
```

`void` rather than `await` keeps the reap off the boot critical path — but only because every
helper call inside it is asynchronous. `void` alone would not have done it: an async function's
body runs synchronously until its first real await, so a `spawnSync` in there would block boot
just as much as awaiting the whole thing. The non-blocking property lives in `win32-reap.ts`, not
at this call site.

- [ ] **Step 6: Correct the two false statements**

`docs/architecture.md` (~line 1795) currently answers *Extension sandbox escape* with "…AppContainer + orphan-reap on Windows". It is now true — but only once this task lands, so confirm the wording matches what shipped rather than assuming.

`.claude/commands/nimbus-file-map.md` (~line 47) says "Windows AppContainer orphan-reap at Gateway startup". Same: true as of this commit. Add the wiring site so the claim is checkable:

```text
| `packages/gateway/src/platform/sandbox/{orphan-reap,win32-reap}.ts` | Windows AppContainer orphan-reap, wired at `platform/assemble.ts` boot |
```

- [ ] **Step 7: Verify and commit**

```bash
bun test packages/gateway/src/platform/sandbox
bun run preflight:fast
git add -u && git add packages/gateway/src/platform/sandbox/win32-reap.ts packages/gateway/src/platform/sandbox/win32-reap.test.ts
git commit -F - <<'EOF'
fix(sandbox): wire the AppContainer orphan reaper at boot

reapOrphanedAppContainers had no production caller, while architecture.md's
threat table and the file map both described it as running. Shipping real
profile creation without it would accumulate per-user registry state across
every install cycle and leave orphaned SIDs on granted paths.

Both documents now describe what actually executes.
EOF
```

---

### Task 8: Ship it — packaging, and the docs that must match

**Files:**

- Modify: `.github/workflows/release.yml` (Windows zip staging ~line 540; MSI staging ~line 318)
- Modify: `scripts/package-windows-installer.ps1`
- Modify: `scripts/release/nimbus.wxs`
- Modify: `docs/sandbox.md`
- Modify: `packages/gateway/src/platform/sandbox/win32.ts` (the "tracked follow-up" comment)

**Interfaces:**

- Consumes: `nimbus-sandbox-helper.exe` from Tasks 3–4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Build the helper in the release workflow**

The gateway build matrix already runs on `windows-2025`. In the `build-gateway` job, after checkout and before the artifact upload, add a Windows-only step:

```yaml
      - name: Build sandbox helper (Windows)
        if: matrix.target.os == 'windows'
        shell: pwsh
        run: |
          bun run build:sandbox-helper:win32
          Copy-Item packages/gateway/src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe dist/
```

so it rides the existing `nimbus-gateway-windows-x64` artifact alongside `vec0.dll`.

- [ ] **Step 2: Stage it into the zip**

In the archive step (~line 540), beside the `vec0.dll` copy:

```bash
          cp dist/nimbus-gateway-windows-x64/nimbus-sandbox-helper.exe    dist/stage-windows-x64/nimbus-sandbox-helper.exe
```

- [ ] **Step 3: Stage it into the MSI**

In `build-msi`'s "Stage exes" step:

```powershell
          Copy-Item dist/nimbus-gateway-windows-x64/nimbus-sandbox-helper.exe dist/msi-bin/nimbus-sandbox-helper.exe
```

In `scripts/package-windows-installer.ps1`, add `nimbus-sandbox-helper.exe` to the required-payload loop at line 28 — the script already throws on a missing `vec0.dll`, and a silently-absent helper would ship an MSI whose sandbox cannot spawn. Add the matching `Component` to `scripts/release/nimbus.wxs`, modelled on the existing `vec0.dll` component.

The helper must land **beside the gateway executable**, because `defaultHelperPath()` resolves `dirname(process.execPath)`.

- [ ] **Step 4: Rewrite the Windows sections of docs/sandbox.md**

`#windows-platform-status` currently says the FFI binding "is a work-in-progress in PR 1" and tells users who see the error to file an issue. Replace with what shipped: the helper, its unprivileged nature, the ACL grant, the Job Object, and the non-ACL-filesystem failure mode. Leave `#platform-asymmetry` intact — the all-or-nothing `internetClient` row is still accurate, and this work did not close it.

- [ ] **Step 5: Settle the "tracked follow-up" comment**

The old comment referred to a tracking issue that never existed. It is deleted along with the stub in Task 5; confirm no other file still refers to a pending FFI binding:

```bash
grep -rn "CreateProcessAsUserW\|work-in-progress in PR 1" --include='*.ts' --include='*.md' . | grep -v node_modules
```

Expect zero hits outside `docs/superpowers/specs/` (historical records) after this task.

- [ ] **Step 6: Full verification**

```bash
bun run preflight
bun run typecheck:tests
```

Both must be green. `preflight` fail-fasts, so a failure in an early gate hides later ones — re-run after each fix rather than assuming the rest passed.

- [ ] **Step 7: Commit and open the PR**

```bash
git add -u
git commit -F - <<'EOF'
build(sandbox): ship the windows helper in the zip and the msi

The helper installs beside the gateway executable, which is where the
runner resolves it from. The MSI packaging script now treats it as a
required payload, so a build that lost it fails loudly instead of shipping
an installer whose sandbox cannot spawn.

Rewrites the Windows sections of docs/sandbox.md to describe what shipped.
The all-or-nothing internetClient asymmetry is unchanged and stays
documented as such.
EOF
git push -u origin dev/asafgolombek/windows-sandbox-policy
```

PR title must carry the conventional-commit type — it is what release-please parses, and the squash commit is built from the PR title and body, not from any local commit message. Suggested: `feat(sandbox): a real Windows sandbox leg, and a policy-shaped runner interface`. Check the body for unbalanced parentheses before opening; an unbalanced `(` in a PR body has dropped a commit from release-please three times.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §1 helper → Tasks 3–4; §1 runner → Task 5; §1 build/ship → Tasks 3 (CI) and 8 (release); §1 profile lifecycle/privilege/Job Object/non-NTFS → Tasks 3, 4, 7; §2 policy → Task 2; §3 testing → Tasks 5–6; §4 ACL risk → Task 1; §4 honesty items → Tasks 7–8. Every acceptance criterion in the spec has a step that produces it.

**Deliberately deferred, and why.** `limits.wallClockMs` ships declared-and-unenforced — Task 2 documents it in the type. The one-shot profile-id scheme is not decided here: it belongs to the execution surface, which is a stated non-goal, and Task 3's `--delete-profile` namespace check plus Task 7's reaper are the two constraints the spec binds it to. Per-host network filtering on Windows stays open.

**Known bound.** Tasks 3–5 are only fully verifiable on Windows hardware. The Linux and macOS legs of Task 6 are the guard against a Windows-shaped fix breaking them, and `bun run verify:docker` covers the Linux side locally.

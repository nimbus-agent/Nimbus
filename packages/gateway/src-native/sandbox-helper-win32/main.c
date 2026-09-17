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
#include <sddl.h>
#include <stdio.h>
#include <wchar.h>

#define PROFILE_PREFIX L"nimbus-"
/* The real per-user AppContainer mapping key. Not the shorter, plausible-looking
 * "Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings" — that key does not
 * exist on a real install; CreateAppContainerProfile/DeriveAppContainerSidFromAppContainerName
 * register profiles under this "Local Settings" path instead. Verified directly against the
 * registry (171 subkeys here vs. 0 under the shorter path) rather than assumed. */
#define MAPPINGS_KEY   L"Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\" \
                       L"CurrentVersion\\AppContainer\\Mappings"

/*
 * The single diagnostic sink for all 26 error sites: prefix, message, newline.
 *
 * A MACRO, not a variadic function (c:S923 / MISRA C 2012 Rule 17.1). It was `static void
 * err(const wchar_t *fmt, ...)` forwarding to vfwprintf, which is the type-unsafe construction
 * those rules exist to remove: va_arg cannot check that the arguments match the format, so a
 * mismatched `%s` reads a Win32 error code as a pointer. Forwarding to fwprintf textually instead
 * removes <stdarg.h> entirely AND puts a literal format string directly in front of its arguments
 * at every call site, so MSVC's own format checking (C4477 under the /W4 /WX this is built with)
 * applies where it previously could not see past the wrapper. Call sites are unchanged.
 *
 * Rewriting each site to pre-format into its own stack buffer would have been the other way to
 * drop the ellipsis, and is worse: 26 hand-managed buffers in security-sensitive C, none of them
 * type-checked either.
 *
 * `do { ... } while (0)` so `err(...)` is a statement everywhere, including as an unbraced `if`
 * body. Safe under /W4: the same idiom already compiles here as `PUT` in append_quoted.
 */
#define err(...) do {                                    \
        fwprintf(stderr, L"nimbus-sandbox-helper: ");     \
        fwprintf(stderr, __VA_ARGS__);                    \
        fwprintf(stderr, L"\n");                          \
    } while (0)

/* Create the profile, or derive its SID if it already exists. Caller frees with FreeSid.
 * When `created` is non-NULL it reports which of the two happened — only --check-caps needs
 * that, to avoid deleting a profile it did not make. */
static HRESULT profile_sid_ex(const wchar_t *name, PSID *out, BOOL *created) {
    HRESULT hr = CreateAppContainerProfile(name, name, L"Nimbus sandbox", NULL, 0, out);
    if (created) *created = SUCCEEDED(hr);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(name, out);
    }
    return hr;
}

static HRESULT profile_sid(const wchar_t *name, PSID *out) {
    return profile_sid_ex(name, out, NULL);
}

static int mode_check_caps(void) {
    PSID sid = NULL;
    BOOL created = FALSE;
    /* nimbus-ext- prefix (not nimbus-probe): the orphan reaper (Task 7) matches only that
     * prefix, so a probe profile whose deletion below ever failed is still collectible —
     * it reads as extension id "probe", which is never live. */
    HRESULT hr = profile_sid_ex(L"nimbus-ext-probe", &sid, &created);
    if (FAILED(hr)) {
        err(L"cannot create an AppContainer profile: hr=0x%08lx", (unsigned long)hr);
        return 1;
    }
    FreeSid(sid);
    /* The probe profile is transient state; do not leave it behind — but delete it ONLY if this
     * invocation created it. `SandboxPolicy.id` is an unconstrained string, so an extension
     * literally named "probe" owns this exact profile name (profileNameFor -> nimbus-ext-probe),
     * and an unconditional delete here would tear down live state a probe has no business
     * touching. If it already existed, leave it: the reaper collects it when "probe" is not
     * installed, and must not when it is. */
    if (created) DeleteAppContainerProfile(L"nimbus-ext-probe");
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

/*
 * Grant `sid` the requested rights on `path`. Returns 0, or 66 on failure — which is also what a
 * non-ACL filesystem (FAT32/exFAT, some network shares) produces, since SetNamedSecurityInfoW
 * cannot write a DACL there. The caller must not fall back to spawning unconfined: a policy path
 * the child cannot read is a failure to enforce, not a warning.
 *
 * `inherit` is load-bearing, not a detail. Every call site today passes
 * SUB_CONTAINERS_AND_OBJECTS_INHERIT, which propagates the ACE to everything beneath `path` — the
 * cwd and every policy read/write path are each meant as their own subtree grant. There is no
 * ancestor-directory grant call anywhere: an earlier revision granted ancestors a non-inheritable
 * listing right so the container could traverse down to a nested cwd/policy path, but that
 * mechanism was removed — Windows bypasses traverse checking by default, so a known full path
 * opens without listing rights on the way down, and the ancestor grants were dead weight. Task 6's
 * out-of-policy-read test is the guard against reintroducing an inheritable grant that leaks a
 * sibling subtree: its `outside` directory sits next to the granted cwd, so a widened inheritance
 * on the wrong path makes that test fail. Do not widen a grant to make it pass.
 */
static int grant_path(const wchar_t *path, PSID sid, DWORD rights, DWORD inherit) {
    PACL old_acl = NULL;
    PACL new_acl = NULL;
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
        err(L"SetNamedSecurityInfoW(%s): %lu - the path may be on a filesystem without ACL "
            L"support (FAT32/exFAT or a network share), or access is denied; the sandbox "
            L"cannot enforce this policy",
            path, rc);
        return 66;
    }
    return 0;
}

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

#define MAX_GRANTS 64

/* Parsed `--profile ... -- <child argv>` invocation. `child_argv_start` is the index of the first
 * token AFTER the `--` separator. */
typedef struct {
    const wchar_t *profile;
    const wchar_t *cwd;
    BOOL want_net;
    const wchar_t *reads[MAX_GRANTS];
    int nread;
    const wchar_t *writes[MAX_GRANTS];
    int nwrite;
    int child_argv_start;
} spawn_opts;

/* Consume ONE option token at argv[*i], advancing *i past its value. Returns 0, or the process
 * exit code the caller must return verbatim — every failure path has already emitted its own
 * diagnostic. Split out of parse_spawn_args for cognitive complexity (S3776): the chain below is
 * the same chain, with `argv[i]`/`++i` written against the caller's index. The accepted grammar is
 * unchanged — in particular a known flag that is the LAST token still fails its `*i + 1 < argc`
 * guard and falls through to the same "unexpected arg" refusal it did before. */
static int parse_spawn_option(int argc, wchar_t **argv, int *i, spawn_opts *o) {
    if (wcscmp(argv[*i], L"--profile") == 0 && *i + 1 < argc)          { o->profile = argv[++(*i)]; }
    else if (wcscmp(argv[*i], L"--cwd") == 0 && *i + 1 < argc)         { o->cwd = argv[++(*i)]; }
    else if (wcscmp(argv[*i], L"--capability") == 0 && *i + 1 < argc)  { ++(*i); if (wcscmp(argv[*i], L"internetClient") == 0) o->want_net = TRUE; }
    else if (wcscmp(argv[*i], L"--grant-read") == 0 && *i + 1 < argc)  { if (o->nread  >= MAX_GRANTS) { err(L"too many --grant-read");  return 64; } o->reads[o->nread++]   = argv[++(*i)]; }
    else if (wcscmp(argv[*i], L"--grant-write") == 0 && *i + 1 < argc) { if (o->nwrite >= MAX_GRANTS) { err(L"too many --grant-write"); return 64; } o->writes[o->nwrite++] = argv[++(*i)]; }
    else { err(L"unexpected arg: %s", argv[*i]); return 64; }
    return 0;
}

/* Parse argv into `o`. Returns 0, or the process exit code the caller must return verbatim —
 * every failure path has already emitted its own diagnostic. Split out of mode_spawn for
 * cognitive complexity (S3776); the accepted grammar is unchanged. */
static int parse_spawn_args(int argc, wchar_t **argv, spawn_opts *o) {
    o->profile = NULL;
    o->cwd = NULL;
    o->want_net = FALSE;
    o->nread = 0;
    o->nwrite = 0;

    int i = 1;
    for (; i < argc; i++) {
        if (wcscmp(argv[i], L"--") == 0) { i++; break; }
        int rc = parse_spawn_option(argc, argv, &i, o);
        if (rc != 0) return rc;
    }
    o->child_argv_start = i;

    if (o->profile == NULL) { err(L"--profile is required"); return 64; }
    if (o->cwd == NULL)     { err(L"--cwd is required"); return 64; }
    if (i >= argc)          { err(L"expected -- followed by child argv"); return 64; }
    return 0;
}

/* Apply the cwd grant and the policy-path grants. Returns 0 or the exit code. Does NOT free
 * `sid` — the caller owns it on every path, which is why this returns a code rather than
 * cleaning up itself. */
static int apply_grants(PSID sid, const spawn_opts *o) {
    /* The working directory: Modify, inheritable — the child works inside it. */
    int rc = grant_path(o->cwd, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
    if (rc != 0) return rc;

    /* Policy paths are subtree grants, so they inherit. Their ancestors get NOTHING: Windows
     * bypasses traverse checking by default, so a known full path opens without listing rights on
     * the way down — the spike's failure was on ENUMERATION, not traversal. If a connector turns
     * out to need more than this, widen it deliberately and record why; do not widen on a hunch. */
    for (int k = 0; k < o->nread; k++) {
        rc = grant_path(o->reads[k], sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
        if (rc != 0) return rc;
    }
    for (int k = 0; k < o->nwrite; k++) {
        rc = grant_path(o->writes[k], sid,
                        FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE,
                        SUB_CONTAINERS_AND_OBJECTS_INHERIT);
        if (rc != 0) return rc;
    }
    return 0;
}

static int mode_spawn(int argc, wchar_t **argv) {
    spawn_opts o;
    int prc = parse_spawn_args(argc, argv, &o);
    if (prc != 0) return prc;

    const wchar_t *cwd = o.cwd;
    const BOOL want_net = o.want_net;
    const int i = o.child_argv_start;

    PSID sid = NULL;
    HRESULT hr = profile_sid(o.profile, &sid);
    if (FAILED(hr)) { err(L"profile %s: hr=0x%08lx", o.profile, (unsigned long)hr); return 65; }

    int rc = apply_grants(sid, &o);
    if (rc != 0) { FreeSid(sid); return rc; }

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

/* ------------------------------------------------------------------------------------------------
 * Releasing grants. grant_path only ever ADDS an ACE, and deleting a profile does not remove one:
 * the ACE survives as an unresolvable S-1-15-2-* entry. For a policy id that is new on every run
 * (`exec-<id>`, `cu-terminal-<id>`) that meant one more ACE per run on every path that outlives it
 * — the runtime bin dir above all — until SetEntriesInAclW failed with 87 and every confined spawn
 * on the machine refused. These two modes are the removal half. Both are driven by the GATEWAY,
 * not by mode_spawn after its wait: the gateway ends terminal sessions and timed-out executions
 * with TerminateProcess on this helper, so nothing after WaitForSingleObject runs on those paths.
 * ---------------------------------------------------------------------------------------------- */

#define MAX_RELEASE_PATHS 256

/* A path that is already gone has no ACE left to remove: success, not failure. The caller may
 * reasonably delete a temp working directory before or while the release runs. */
static BOOL path_is_gone(DWORD rc) {
    return rc == ERROR_FILE_NOT_FOUND || rc == ERROR_PATH_NOT_FOUND;
}

/* Remove every explicit ACE held by each of `sids` from `path`'s DACL in ONE rewrite. Returns 0 on
 * success (including a path that no longer exists), 1 on failure with the reason on stderr. */
static int revoke_sids_on_path(const wchar_t *path, PSID *sids, ULONG nsids) {
    if (nsids == 0) return 0;
    PACL old_acl = NULL;
    PACL new_acl = NULL;
    PSECURITY_DESCRIPTOR sd = NULL;
    DWORD rc = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                     DACL_SECURITY_INFORMATION, NULL, NULL, &old_acl, NULL, &sd);
    if (path_is_gone(rc)) return 0;
    if (rc != ERROR_SUCCESS) { err(L"GetNamedSecurityInfoW(%s): %lu", path, rc); return 1; }

    EXPLICIT_ACCESS_W *ea = (EXPLICIT_ACCESS_W *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY,
                                                           sizeof(EXPLICIT_ACCESS_W) * nsids);
    if (ea == NULL) { LocalFree(sd); err(L"HeapAlloc: out of memory"); return 1; }
    for (ULONG k = 0; k < nsids; k++) {
        ea[k].grfAccessMode       = REVOKE_ACCESS;
        ea[k].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        ea[k].Trustee.TrusteeType = TRUSTEE_IS_GROUP;
        ea[k].Trustee.ptstrName   = (LPWSTR)sids[k];
    }
    rc = SetEntriesInAclW(nsids, ea, old_acl, &new_acl);
    HeapFree(GetProcessHeap(), 0, ea);
    if (rc != ERROR_SUCCESS) { LocalFree(sd); err(L"SetEntriesInAclW(%s): %lu", path, rc); return 1; }

    rc = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                               DACL_SECURITY_INFORMATION, NULL, NULL, new_acl, NULL);
    LocalFree(new_acl);
    LocalFree(sd);
    if (path_is_gone(rc)) return 0;
    if (rc != ERROR_SUCCESS) { err(L"SetNamedSecurityInfoW(%s): %lu", path, rc); return 1; }
    return 0;
}

/* --revoke-grants --profile <name> [--path <p>]... */
static int mode_revoke_grants(int argc, wchar_t **argv) {
    const wchar_t *profile = NULL;
    const wchar_t *paths[MAX_RELEASE_PATHS];
    int npaths = 0;
    for (int i = 2; i < argc; i++) {
        if (wcscmp(argv[i], L"--profile") == 0 && i + 1 < argc) {
            profile = argv[++i];
        } else if (wcscmp(argv[i], L"--path") == 0 && i + 1 < argc) {
            if (npaths >= MAX_RELEASE_PATHS) { err(L"too many --path"); return 64; }
            paths[npaths++] = argv[++i];
        } else {
            err(L"unexpected arg: %s", argv[i]);
            return 64;
        }
    }
    if (profile == NULL) { err(L"--revoke-grants requires --profile"); return 64; }
    if (wcsncmp(profile, PROFILE_PREFIX, wcslen(PROFILE_PREFIX)) != 0) {
        err(L"refusing to revoke grants outside the %s namespace: %s", PROFILE_PREFIX, profile);
        return 64;
    }

    /* Derived, never created: the SID is a function of the name, so this works whether or not the
     * profile still exists — and it must not re-register a profile the caller is tearing down. */
    PSID sid = NULL;
    HRESULT hr = DeriveAppContainerSidFromAppContainerName(profile, &sid);
    if (FAILED(hr)) { err(L"derive SID for %s: hr=0x%08lx", profile, (unsigned long)hr); return 1; }

    int status = 0;
    for (int k = 0; k < npaths; k++) {
        /* One failed path must not strand the rest: keep going, report at the end. */
        if (revoke_sids_on_path(paths[k], &sid, 1) != 0) status = 1;
    }
    FreeSid(sid);
    return status;
}

/* S-1-15-2-*: the APP_PACKAGE authority (15) with base RID 2. Capability SIDs (S-1-15-3-*) are not
 * profiles and are never touched. */
static BOOL is_app_container_sid(PSID sid) {
    const SID_IDENTIFIER_AUTHORITY *auth = GetSidIdentifierAuthority(sid);
    static const BYTE want[6] = {0, 0, 0, 0, 0, 15};
    if (memcmp(auth->Value, want, sizeof(want)) != 0) return FALSE;
    if (*GetSidSubAuthorityCount(sid) < 1) return FALSE;
    return *GetSidSubAuthority(sid, 0) == SECURITY_APP_PACKAGE_BASE_RID;
}

/* An ACE's SID is orphaned only when BOTH independent checks agree it names nothing:
 *   1. no subkey under the per-user Mappings key — which lists installed packages (Notepad, VCLibs)
 *      as well as CreateAppContainerProfile profiles, so a Store app's grant is never an orphan;
 *   2. LookupAccountSidW reports ERROR_NONE_MAPPED.
 * Anything short of a clean "not there" on either check (an access error, a lookup that fails for
 * another reason) keeps the ACE: removing a live grant breaks a running app, while keeping an
 * orphan costs one ACL entry. */
static BOOL is_orphaned_sid(PSID sid) {
    LPWSTR str = NULL;
    if (!ConvertSidToStringSidW(sid, &str)) return FALSE;
    wchar_t key[512];
    int n = swprintf(key, 512, L"%s\\%s", MAPPINGS_KEY, str);
    LocalFree(str);
    if (n < 0) return FALSE;

    HKEY h;
    LSTATUS rs = RegOpenKeyExW(HKEY_CURRENT_USER, key, 0, KEY_READ, &h);
    if (rs == ERROR_SUCCESS) { RegCloseKey(h); return FALSE; }
    if (rs != ERROR_FILE_NOT_FOUND) return FALSE;

    wchar_t name[256];
    wchar_t domain[256];
    DWORD nlen = 256;
    DWORD dlen = 256;
    SID_NAME_USE use;
    if (LookupAccountSidW(NULL, sid, name, &nlen, domain, &dlen, &use)) return FALSE;
    return GetLastError() == ERROR_NONE_MAPPED;
}

/* Collect the distinct orphaned app-container SIDs holding an explicit ACCESS_ALLOWED ACE on `acl`.
 * The returned pointers point INTO `acl`, so they are valid only while its security descriptor is.
 * Returns the count, or -1 on allocation failure. `*out` is freed by the caller with HeapFree. */
static int collect_orphans(PACL acl, PSID **out) {
    *out = NULL;
    if (acl == NULL) return 0;
    ACL_SIZE_INFORMATION info;
    if (!GetAclInformation(acl, &info, sizeof(info), AclSizeInformation)) return 0;
    if (info.AceCount == 0) return 0;
    PSID *found = (PSID *)HeapAlloc(GetProcessHeap(), 0, sizeof(PSID) * info.AceCount);
    if (found == NULL) return -1;

    int count = 0;
    for (DWORD i = 0; i < info.AceCount; i++) {
        LPVOID raw = NULL;
        if (!GetAce(acl, i, &raw)) continue;
        const ACE_HEADER *hdr = (const ACE_HEADER *)raw;
        if (hdr->AceType != ACCESS_ALLOWED_ACE_TYPE) continue;
        if ((hdr->AceFlags & INHERITED_ACE) != 0) continue; /* the parent's to remove, not ours */
        PSID sid = (PSID)&((ACCESS_ALLOWED_ACE *)raw)->SidStart;
        if (!is_app_container_sid(sid)) continue;
        BOOL seen = FALSE;
        for (int k = 0; k < count && !seen; k++) seen = EqualSid(found[k], sid);
        if (seen || !is_orphaned_sid(sid)) continue;
        found[count++] = sid;
    }
    *out = found;
    return count;
}

/* --sweep-orphaned-aces <path>... */
static int mode_sweep_orphaned_aces(int argc, wchar_t **argv) {
    if (argc < 3) { err(L"--sweep-orphaned-aces requires at least one path"); return 64; }
    int status = 0;
    for (int i = 2; i < argc; i++) {
        const wchar_t *path = argv[i];
        PACL acl = NULL;
        PSECURITY_DESCRIPTOR sd = NULL;
        DWORD rc = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                         DACL_SECURITY_INFORMATION, NULL, NULL, &acl, NULL, &sd);
        if (path_is_gone(rc)) { wprintf(L"removed 0 %s\n", path); continue; }
        if (rc != ERROR_SUCCESS) { err(L"GetNamedSecurityInfoW(%s): %lu", path, rc); status = 1; continue; }

        PSID *orphans = NULL;
        int n = collect_orphans(acl, &orphans);
        if (n < 0) { LocalFree(sd); err(L"HeapAlloc: out of memory"); status = 1; continue; }
        /* revoke_sids_on_path re-reads the DACL itself; `orphans` points into `sd`, which stays
         * alive until after it returns, so the SIDs it is handed remain valid throughout. */
        int r = revoke_sids_on_path(path, orphans, (ULONG)n);
        if (orphans != NULL) HeapFree(GetProcessHeap(), 0, orphans);
        LocalFree(sd);
        if (r != 0) { status = 1; continue; }
        wprintf(L"removed %d %s\n", n, path);
    }
    return status;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) { err(L"usage: --check-caps | --list-profiles | --delete-profile <name> | --revoke-grants --profile <name> [--path <p>]... | --sweep-orphaned-aces <path>... | --profile <name> [...] -- <argv>"); return 64; }
    if (wcscmp(argv[1], L"--check-caps") == 0)     return mode_check_caps();
    if (wcscmp(argv[1], L"--list-profiles") == 0)  return mode_list_profiles();
    if (wcscmp(argv[1], L"--delete-profile") == 0) {
        if (argc < 3) { err(L"--delete-profile requires a name"); return 64; }
        return mode_delete_profile(argv[2]);
    }
    if (wcscmp(argv[1], L"--revoke-grants") == 0)       return mode_revoke_grants(argc, argv);
    if (wcscmp(argv[1], L"--sweep-orphaned-aces") == 0) return mode_sweep_orphaned_aces(argc, argv);
    if (wcscmp(argv[1], L"--profile") == 0) return mode_spawn(argc, argv);
    err(L"unknown mode: %s", argv[1]);
    return 64;
}

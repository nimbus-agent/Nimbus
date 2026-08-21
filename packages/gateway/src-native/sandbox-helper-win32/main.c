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
#include <stdarg.h>
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
    /* nimbus-ext- prefix (not nimbus-probe): the orphan reaper (Task 7) matches only that
     * prefix, so a probe profile whose deletion below ever failed is still collectible —
     * it reads as extension id "probe", which is never live. */
    HRESULT hr = profile_sid(L"nimbus-ext-probe", &sid);
    if (FAILED(hr)) {
        err(L"cannot create an AppContainer profile: hr=0x%08lx", (unsigned long)hr);
        return 1;
    }
    FreeSid(sid);
    /* The probe profile is transient state; do not leave it behind. */
    DeleteAppContainerProfile(L"nimbus-ext-probe");
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
        err(L"SetNamedSecurityInfoW(%s): %lu - the path may be on a filesystem without ACL "
            L"support (FAT32/exFAT or a network share), or access is denied; the sandbox "
            L"cannot enforce this policy",
            path, rc);
        return 66;
    }
    return 0;
}

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

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) { err(L"usage: --check-caps | --list-profiles | --delete-profile <name> | --profile <name> [...] -- <argv>"); return 64; }
    if (wcscmp(argv[1], L"--check-caps") == 0)     return mode_check_caps();
    if (wcscmp(argv[1], L"--list-profiles") == 0)  return mode_list_profiles();
    if (wcscmp(argv[1], L"--delete-profile") == 0) {
        if (argc < 3) { err(L"--delete-profile requires a name"); return 64; }
        return mode_delete_profile(argv[2]);
    }
    if (wcscmp(argv[1], L"--profile") == 0) return mode_spawn(argc, argv);
    err(L"unknown mode: %s", argv[1]);
    return 64;
}

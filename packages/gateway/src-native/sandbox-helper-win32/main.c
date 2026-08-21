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

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) { err(L"usage: --check-caps | --list-profiles | --delete-profile <name> | --profile <name> [...] -- <argv>"); return 64; }
    if (wcscmp(argv[1], L"--check-caps") == 0)     return mode_check_caps();
    if (wcscmp(argv[1], L"--list-profiles") == 0)  return mode_list_profiles();
    if (wcscmp(argv[1], L"--delete-profile") == 0) {
        if (argc < 3) { err(L"--delete-profile requires a name"); return 64; }
        return mode_delete_profile(argv[2]);
    }
    /* --profile ... -- <argv> (the spawn mode) is a later task; reject it as unknown for now. */
    err(L"unknown mode: %s", argv[1]);
    return 64;
}

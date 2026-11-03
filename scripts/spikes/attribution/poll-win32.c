/*
 * Spike 6a (quality layer, spec section 10.2): can an UNELEVATED process attribute a TCP connection
 * to a sandboxed extension's real child on Windows? Throwaway; never merges.
 *
 * Usage: poll-win32.exe <root pid> <period ms> <duration ms>
 *
 * Every period: a Toolhelp snapshot gives the descendants of <root pid> (the helper the gateway
 * spawned; the AppContainer child is its child); GetExtendedTcpTable (IPv4 and IPv6, owner PID)
 * gives every connection. A row is attributed when
 *   - "tree": its owning PID is a descendant of the root, and/or
 *   - "sid":  its owning process's token carries the AppContainer SID that the root's first
 *             AppContainer descendant carries (read once, then compared as strings).
 * Prints one JSON line per distinct (pid, local port, remote) with the methods that matched, then a
 * summary line with iterations and this process's CPU time.
 */
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <tlhelp32.h>
#include <sddl.h>
#include <timeapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "winmm.lib")
#pragma comment(lib, "kernel32.lib")

#define MAX_PIDS 4096
#define MAX_SEEN 4096

typedef struct {
    DWORD pid;
    unsigned short lport;
    char remote[64];
    unsigned short rport;
    int by_tree;
    int by_sid;
    ULONGLONG first_ms;
} Seen;

static Seen seen[MAX_SEEN];
static int nseen = 0;
static wchar_t container_sid[256] = L"";
static DWORD sid_pid_cache[MAX_PIDS];
static int sid_cache_match[MAX_PIDS];
static int nsid_cache = 0;

/* The AppContainer SID string of a process, or "" when it has none or cannot be opened. */
static void token_container_sid(DWORD pid, wchar_t *out, size_t cap) {
    out[0] = 0;
    HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (p == NULL) return;
    HANDLE t = NULL;
    if (OpenProcessToken(p, TOKEN_QUERY, &t)) {
        BYTE buf[512];
        DWORD len = 0;
        if (GetTokenInformation(t, TokenAppContainerSid, buf, sizeof(buf), &len)) {
            TOKEN_APPCONTAINER_INFORMATION *info = (TOKEN_APPCONTAINER_INFORMATION *)buf;
            if (info->TokenAppContainer != NULL) {
                LPWSTR s = NULL;
                if (ConvertSidToStringSidW(info->TokenAppContainer, &s)) {
                    wcsncpy_s(out, cap, s, _TRUNCATE);
                    LocalFree(s);
                }
            }
        }
        CloseHandle(t);
    }
    CloseHandle(p);
}

/* Cached per PID for the run: whether its token carries the extension's container SID. */
static int pid_has_container_sid(DWORD pid) {
    if (container_sid[0] == 0) return 0;
    for (int i = 0; i < nsid_cache; i++) if (sid_pid_cache[i] == pid) return sid_cache_match[i];
    wchar_t s[256];
    token_container_sid(pid, s, 256);
    int m = s[0] != 0 && wcscmp(s, container_sid) == 0;
    if (nsid_cache < MAX_PIDS) { sid_pid_cache[nsid_cache] = pid; sid_cache_match[nsid_cache] = m; nsid_cache++; }
    return m;
}

/* Descendants of root (root included) from one Toolhelp snapshot. */
static int descendants(DWORD root, DWORD *out, int cap) {
    static DWORD pids[MAX_PIDS], ppids[MAX_PIDS];
    int n = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W e;
    e.dwSize = sizeof(e);
    if (Process32FirstW(snap, &e)) {
        do {
            if (n < MAX_PIDS) { pids[n] = e.th32ProcessID; ppids[n] = e.th32ParentProcessID; n++; }
        } while (Process32NextW(snap, &e));
    }
    CloseHandle(snap);
    int k = 0;
    out[k++] = root;
    for (int i = 0; i < k && k < cap; i++) {
        for (int j = 0; j < n && k < cap; j++) {
            if (ppids[j] == out[i] && pids[j] != out[i] && pids[j] != 0) {
                int dup = 0;
                for (int q = 0; q < k; q++) if (out[q] == pids[j]) { dup = 1; break; }
                if (!dup) out[k++] = pids[j];
            }
        }
    }
    return k;
}

static int in_set(DWORD pid, const DWORD *set, int n) {
    for (int i = 0; i < n; i++) if (set[i] == pid) return 1;
    return 0;
}

static void record(DWORD pid, unsigned short lport, const char *remote, unsigned short rport,
                   int by_tree, int by_sid, ULONGLONG now) {
    for (int i = 0; i < nseen; i++) {
        Seen *s = &seen[i];
        if (s->pid == pid && s->lport == lport && s->rport == rport && strcmp(s->remote, remote) == 0) {
            s->by_tree |= by_tree;
            s->by_sid |= by_sid;
            return;
        }
    }
    if (nseen >= MAX_SEEN) return;
    Seen *s = &seen[nseen++];
    s->pid = pid; s->lport = lport; s->rport = rport; s->by_tree = by_tree; s->by_sid = by_sid;
    s->first_ms = now;
    strncpy_s(s->remote, sizeof(s->remote), remote, _TRUNCATE);
}

static void scan(ULONG af, const DWORD *tree, int ntree, ULONGLONG now) {
    static BYTE *buf = NULL;
    static DWORD cap = 0;
    DWORD size = cap;
    DWORD rc = GetExtendedTcpTable(buf, &size, FALSE, af, TCP_TABLE_OWNER_PID_ALL, 0);
    if (rc == ERROR_INSUFFICIENT_BUFFER) {
        free(buf);
        cap = size * 2;
        buf = (BYTE *)malloc(cap);
        size = cap;
        rc = GetExtendedTcpTable(buf, &size, FALSE, af, TCP_TABLE_OWNER_PID_ALL, 0);
    }
    if (rc != NO_ERROR || buf == NULL) return;
    char remote[64];
    if (af == AF_INET) {
        MIB_TCPTABLE_OWNER_PID *t = (MIB_TCPTABLE_OWNER_PID *)buf;
        for (DWORD i = 0; i < t->dwNumEntries; i++) {
            MIB_TCPROW_OWNER_PID *r = &t->table[i];
            if (r->dwRemoteAddr == 0) continue; /* listeners */
            int bt = in_set(r->dwOwningPid, tree, ntree);
            int bs = pid_has_container_sid(r->dwOwningPid);
            if (!bt && !bs) continue;
            struct in_addr a; a.S_un.S_addr = r->dwRemoteAddr;
            inet_ntop(AF_INET, &a, remote, sizeof(remote));
            record(r->dwOwningPid, ntohs((u_short)r->dwLocalPort), remote, ntohs((u_short)r->dwRemotePort), bt, bs, now);
        }
    } else {
        MIB_TCP6TABLE_OWNER_PID *t = (MIB_TCP6TABLE_OWNER_PID *)buf;
        static const UCHAR zero[16] = {0};
        for (DWORD i = 0; i < t->dwNumEntries; i++) {
            MIB_TCP6ROW_OWNER_PID *r = &t->table[i];
            if (memcmp(r->ucRemoteAddr, zero, 16) == 0) continue;
            int bt = in_set(r->dwOwningPid, tree, ntree);
            int bs = pid_has_container_sid(r->dwOwningPid);
            if (!bt && !bs) continue;
            inet_ntop(AF_INET6, r->ucRemoteAddr, remote, sizeof(remote));
            record(r->dwOwningPid, ntohs((u_short)r->dwLocalPort), remote, ntohs((u_short)r->dwRemotePort), bt, bs, now);
        }
    }
}

int main(int argc, char **argv) {
    if (argc != 4) { fprintf(stderr, "usage: poll-win32 <root pid> <period ms> <duration ms>\n"); return 2; }
    DWORD root = (DWORD)strtoul(argv[1], NULL, 10);
    DWORD period = (DWORD)strtoul(argv[2], NULL, 10);
    DWORD duration = (DWORD)strtoul(argv[3], NULL, 10);
    timeBeginPeriod(1);
    ULONGLONG start = GetTickCount64();
    unsigned long iterations = 0;
    static DWORD tree[MAX_PIDS];
    while (GetTickCount64() - start < duration) {
        ULONGLONG now = GetTickCount64() - start;
        int n = descendants(root, tree, MAX_PIDS);
        if (container_sid[0] == 0) {
            for (int i = 0; i < n; i++) {
                wchar_t s[256];
                token_container_sid(tree[i], s, 256);
                if (s[0] != 0) { wcsncpy_s(container_sid, 256, s, _TRUNCATE); break; }
            }
        }
        scan(AF_INET, tree, n, now);
        scan(AF_INET6, tree, n, now);
        iterations++;
        Sleep(period);
    }
    for (int i = 0; i < nseen; i++) {
        Seen *s = &seen[i];
        printf("{\"pid\":%lu,\"localPort\":%u,\"remote\":\"%s\",\"remotePort\":%u,\"byTree\":%s,\"bySid\":%s,\"firstMs\":%llu}\n",
               s->pid, s->lport, s->remote, s->rport, s->by_tree ? "true" : "false",
               s->by_sid ? "true" : "false", s->first_ms);
    }
    FILETIME c, x, k, u;
    GetProcessTimes(GetCurrentProcess(), &c, &x, &k, &u);
    ULONGLONG kt = ((ULONGLONG)k.dwHighDateTime << 32 | k.dwLowDateTime) / 10000;
    ULONGLONG ut = ((ULONGLONG)u.dwHighDateTime << 32 | u.dwLowDateTime) / 10000;
    char sidbuf[256] = "";
    WideCharToMultiByte(CP_UTF8, 0, container_sid, -1, sidbuf, sizeof(sidbuf), NULL, NULL);
    printf("{\"summary\":true,\"iterations\":%lu,\"cpuMs\":%llu,\"wallMs\":%llu,\"containerSid\":\"%s\"}\n",
           iterations, kt + ut, GetTickCount64() - start, sidbuf);
    timeEndPeriod(1);
    return 0;
}

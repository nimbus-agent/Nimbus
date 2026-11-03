/*
 * Spike 6a (quality layer, spec section 10.2): can an UNELEVATED process attribute a TCP connection
 * to a sandboxed extension's real child on macOS? Throwaway; never merges.
 *
 * Usage: poll-darwin <root pid> <period ms> <duration ms>
 *
 * Every period: descendants of <root pid> (the process the gateway spawned: sandbox-exec, which
 * execs the child in place) from proc_listallpids + PROC_PIDTBSDINFO parent PIDs; for each, its
 * socket fds (PROC_PIDLISTFDS) and each TCP socket's addresses (PROC_PIDFDSOCKETINFO). Prints one
 * JSON line per distinct (pid, local port, remote), then a summary with iterations and CPU time.
 * Also counts how often a libproc call failed with EPERM, which would mean the sandbox hides the
 * child from an unelevated parent.
 */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_PIDS 8192
#define MAX_SEEN 4096

typedef struct {
    pid_t pid;
    int lport;
    char remote[64];
    int rport;
    long first_ms;
} Seen;

static Seen seen[MAX_SEEN];
static int nseen = 0;
static unsigned long eperm = 0;
static unsigned long other_errors = 0;

static long now_ms(struct timespec *start) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (t.tv_sec - start->tv_sec) * 1000 + (t.tv_nsec - start->tv_nsec) / 1000000;
}

static int descendants(pid_t root, pid_t *out, int cap) {
    static pid_t all[MAX_PIDS];
    static pid_t parent[MAX_PIDS];
    int bytes = proc_listallpids(all, sizeof(all));
    int n = bytes > 0 ? bytes : 0;
    if (n > MAX_PIDS) n = MAX_PIDS;
    for (int i = 0; i < n; i++) {
        struct proc_bsdinfo bi;
        parent[i] = -1;
        if (all[i] <= 0) continue;
        if (proc_pidinfo(all[i], PROC_PIDTBSDINFO, 0, &bi, sizeof(bi)) == sizeof(bi)) {
            parent[i] = (pid_t)bi.pbi_ppid;
        }
    }
    int k = 0;
    out[k++] = root;
    for (int i = 0; i < k && k < cap; i++) {
        for (int j = 0; j < n && k < cap; j++) {
            if (parent[j] == out[i] && all[j] != out[i]) {
                int dup = 0;
                for (int q = 0; q < k; q++) if (out[q] == all[j]) { dup = 1; break; }
                if (!dup) out[k++] = all[j];
            }
        }
    }
    return k;
}

static void record(pid_t pid, int lport, const char *remote, int rport, long now) {
    for (int i = 0; i < nseen; i++) {
        Seen *s = &seen[i];
        if (s->pid == pid && s->lport == lport && s->rport == rport && strcmp(s->remote, remote) == 0) return;
    }
    if (nseen >= MAX_SEEN) return;
    Seen *s = &seen[nseen++];
    s->pid = pid; s->lport = lport; s->rport = rport; s->first_ms = now;
    strncpy(s->remote, remote, sizeof(s->remote) - 1);
    s->remote[sizeof(s->remote) - 1] = 0;
}

static void scan_pid(pid_t pid, long now) {
    static struct proc_fdinfo fds[4096];
    int bytes = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, sizeof(fds));
    if (bytes <= 0) {
        if (errno == EPERM) eperm++; else if (errno != ESRCH) other_errors++;
        return;
    }
    int n = bytes / (int)PROC_PIDLISTFD_SIZE;
    for (int i = 0; i < n; i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_SOCKET) continue;
        struct socket_fdinfo si;
        int r = proc_pidfdinfo(pid, fds[i].proc_fd, PROC_PIDFDSOCKETINFO, &si, sizeof(si));
        if (r != sizeof(si)) {
            if (errno == EPERM) eperm++;
            continue;
        }
        if (si.psi.soi_kind != SOCKINFO_TCP) continue;
        struct in_sockinfo *in = &si.psi.soi_proto.pri_tcp.tcpsi_ini;
        int rport = ntohs((unsigned short)in->insi_fport);
        int lport = ntohs((unsigned short)in->insi_lport);
        if (rport == 0) continue;
        char remote[64] = "";
        if (in->insi_vflag & INI_IPV4) {
            inet_ntop(AF_INET, &in->insi_faddr.ina_46.i46a_addr4, remote, sizeof(remote));
        } else {
            inet_ntop(AF_INET6, &in->insi_faddr.ina_6, remote, sizeof(remote));
        }
        record(pid, lport, remote, rport, now);
    }
}

int main(int argc, char **argv) {
    if (argc != 4) { fprintf(stderr, "usage: poll-darwin <root pid> <period ms> <duration ms>\n"); return 2; }
    pid_t root = (pid_t)strtol(argv[1], NULL, 10);
    long period = strtol(argv[2], NULL, 10);
    long duration = strtol(argv[3], NULL, 10);
    struct timespec start;
    clock_gettime(CLOCK_MONOTONIC, &start);
    unsigned long iterations = 0;
    static pid_t tree[MAX_PIDS];
    while (now_ms(&start) < duration) {
        long now = now_ms(&start);
        int n = descendants(root, tree, MAX_PIDS);
        for (int i = 0; i < n; i++) scan_pid(tree[i], now);
        iterations++;
        usleep((useconds_t)(period * 1000));
    }
    for (int i = 0; i < nseen; i++) {
        Seen *s = &seen[i];
        printf("{\"pid\":%d,\"localPort\":%d,\"remote\":\"%s\",\"remotePort\":%d,\"byTree\":true,\"bySid\":false,\"firstMs\":%ld}\n",
               s->pid, s->lport, s->remote, s->rport, s->first_ms);
    }
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    long cpu = (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1000 + (ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1000;
    printf("{\"summary\":true,\"iterations\":%lu,\"cpuMs\":%ld,\"wallMs\":%ld,\"eperm\":%lu,\"otherErrors\":%lu}\n",
           iterations, cpu, now_ms(&start), eperm, other_errors);
    return 0;
}

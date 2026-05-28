/*
 * nimbus-sandbox-helper — Linux-only post-bwrap network confinement.
 *
 * Modes:
 *   --check-caps           — verify CAP_NET_ADMIN is in the permitted set
 *                            (used at install-time by `nimbus doctor` and in CI).
 *
 *   --allow <host> [...]   -- <argv...>
 *                          — resolve each <host>, unshare(CLONE_NEWNET), install
 *                            an iptables/ip6tables OUTPUT-default-DROP ruleset
 *                            that only permits TCP/443 to the resolved IPs (plus
 *                            DNS UDP/TCP 53 and ESTABLISHED,RELATED), drop all
 *                            capabilities, install a post-unshare seccomp BPF
 *                            filter that forbids setns + unshare (so the helper
 *                            cannot itself escape the netns it just created),
 *                            then execv(<argv>).
 *
 * Exit codes:
 *   0   success (only meaningful for --check-caps; --allow execs and never returns)
 *   1   --check-caps: CAP_NET_ADMIN not permitted
 *   2   usage / arg parse error
 *   3   DNS resolution failure
 *   4   unshare(CLONE_NEWNET) failure
 *   5   iptables/ip configuration failure
 *   6   capability drop failure
 *   7   post-unshare seccomp install failure
 *   127 execv failure
 *
 * Build: `make` in this directory; requires libcap-dev. C99 + -Werror clean.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/capability.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>

#define MAX_HOSTS 32

/*
 * Free every non-NULL entry in resolved[0 .. n_allowed-1] and zero the slot.
 * Centralizes the freeaddrinfo cleanup so that the per-IP iteration loop in
 * mode_enforce_and_exec has a single, audited release path on both the error
 * (return 5) and success (post-loop) branches. Idempotent — safe to call
 * twice, since each cleared slot becomes NULL on first release.
 */
static void free_all_resolved(struct addrinfo **resolved, int n_allowed) {
    for (int j = 0; j < n_allowed; j++) {
        if (resolved[j]) {
            freeaddrinfo(resolved[j]);
            resolved[j] = NULL;
        }
    }
}

/*
 * RFC 1123 hostname validator. Semantically mirrors the TypeScript
 * HOSTNAME_RE in packages/gateway/src/extensions/permissions-validator.ts —
 * both ends of the input pipeline (TOML loader + helper argv) enforce the
 * same contract so a malformed hostname never reaches getaddrinfo() with
 * caller-supplied bytes.
 *
 * Rules:
 *   - total length 1..253
 *   - one or more dot-separated labels
 *   - each label length 1..63
 *   - label characters in [A-Za-z0-9-]
 *   - no leading hyphen in any label
 *   - no trailing hyphen in any label
 *   - no empty labels (consecutive dots, leading dot, trailing dot)
 *
 * Returns 1 on accept, 0 on reject.
 */
static int valid_hostname(const char *host) {
    if (host == NULL) {
        return 0;
    }
    size_t len = strlen(host);
    if (len == 0 || len > 253) {
        return 0;
    }
    size_t label_len = 0;
    char last_char_in_label = 0;
    int label_is_new = 1;
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)host[i];
        if (c == '.') {
            if (label_len == 0) {
                /* empty label (leading dot or consecutive dots) */
                return 0;
            }
            if (last_char_in_label == '-') {
                /* trailing hyphen on previous label */
                return 0;
            }
            label_len = 0;
            label_is_new = 1;
            continue;
        }
        int is_alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                       (c >= '0' && c <= '9');
        int is_hyphen = (c == '-');
        if (!is_alnum && !is_hyphen) {
            return 0;
        }
        if (label_is_new && is_hyphen) {
            /* leading hyphen on this label */
            return 0;
        }
        label_len++;
        if (label_len > 63) {
            return 0;
        }
        last_char_in_label = (char)c;
        label_is_new = 0;
    }
    if (label_len == 0) {
        /* trailing dot */
        return 0;
    }
    if (last_char_in_label == '-') {
        /* trailing hyphen on the final label */
        return 0;
    }
    return 1;
}

/*
 * --check-caps mode: verify the binary has CAP_NET_ADMIN in its permitted set
 * (granted via `setcap cap_net_admin+ep` during install or via
 * AmbientCapabilities=CAP_NET_ADMIN in a systemd unit). Used at install time
 * by `nimbus doctor` and in the Linux CI matrix.
 */
static int mode_check_caps(void) {
    cap_t caps = cap_get_proc();
    if (!caps) {
        fprintf(stderr, "cap_get_proc failed: %s\n", strerror(errno));
        return 1;
    }
    cap_flag_value_t value = CAP_CLEAR;
    if (cap_get_flag(caps, CAP_NET_ADMIN, CAP_PERMITTED, &value) != 0) {
        fprintf(stderr, "cap_get_flag failed: %s\n", strerror(errno));
        cap_free(caps);
        return 1;
    }
    cap_free(caps);
    if (value != CAP_SET) {
        fprintf(stderr, "CAP_NET_ADMIN not in permitted set; "
                        "run `setcap cap_net_admin+ep` on this binary\n");
        return 1;
    }
    printf("OK\n");
    return 0;
}

/*
 * Install a small seccomp BPF filter that forbids setns(2) and unshare(2)
 * via SECCOMP_RET_KILL_PROCESS. Installed by the helper *on itself* right
 * before execv(), so:
 *
 *   - the helper cannot re-enter the host's network namespace via setns;
 *   - the helper cannot create *another* netns to escape into via unshare;
 *   - the seccomp filter is inherited across execv (PR_SET_NO_NEW_PRIVS
 *     guarantees the filter cannot be dropped by a suid/file-capability
 *     binary), so the bwrap/connector chain inherits the same restriction.
 *
 * Syscall numbers are x86_64 only (the deployment target):
 *   setns   = 308
 *   unshare = 272
 *
 * The filter's *first* instruction is an architecture check: the BPF program
 * loads seccomp_data.arch (offset 4) and refuses to run on anything other
 * than AUDIT_ARCH_X86_64 by returning SECCOMP_RET_KILL_PROCESS. This is the
 * safer default because the 308 / 272 syscall numbers above are only correct
 * on x86_64; on a different arch they would name unrelated syscalls and the
 * filter would silently allow setns/unshare while denying something benign.
 * aarch64 support is tracked as a follow-up — add another JEQ branch with
 * the aarch64 syscall numbers before the kill, do not loosen the kill.
 *
 * Returns 0 on success, -1 on failure.
 */
static int install_post_unshare_seccomp(void) {
    /* Offsets into struct seccomp_data (uapi/linux/seccomp.h):
     *   nr      = 0  (s32)
     *   arch    = 4  (u32)
     *
     * BPF program (9 instructions, PC-indexed below):
     *   [0] load arch (offset 4)                         A := arch
     *   [1] if A == AUDIT_ARCH_X86_64 jt=1 jf=0          skip [2] on match
     *   [2] KILL_PROCESS                                 (arch mismatch)
     *   [3] load nr (offset 0)                           A := nr
     *   [4] if A == 308 (setns)      jt=0 jf=1           fall through to [5] on match
     *   [5] KILL_PROCESS                                 (setns blocked)
     *   [6] if A == 272 (unshare)    jt=0 jf=1           fall through to [7] on match
     *   [7] KILL_PROCESS                                 (unshare blocked)
     *   [8] ALLOW                                        default
     */
    struct sock_filter filter[] = {
        /* arch = seccomp_data.arch (offset 4) */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 4),

        /* if arch == AUDIT_ARCH_X86_64 (0xC000003E), skip the kill (jt=1);
         * else fall through (jf=0) to KILL_PROCESS. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* nr = seccomp_data.nr (offset 0) */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 0),

        /* if nr == 308 (setns) -> KILL_PROCESS */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 308, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* if nr == 272 (unshare) -> KILL_PROCESS */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 272, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* default: ALLOW */
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog prog = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        fprintf(stderr, "prctl(PR_SET_NO_NEW_PRIVS) failed: %s\n", strerror(errno));
        return -1;
    }
    if (syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog) != 0) {
        fprintf(stderr, "seccomp(SET_MODE_FILTER) failed: %s\n", strerror(errno));
        return -1;
    }
    return 0;
}

/*
 * Printf-style wrapper around `/bin/sh -c <formatted>`. Returns the child's
 * exit status (0 on clean success). Returns -1 on any non-zero exit, on
 * fork/exec failure, or on format truncation (the buffer is 1024 bytes and
 * truncation indicates an iptables argument that is too long to be safe).
 *
 * The helper passes only well-validated values into the format string:
 *   - hardcoded iptables/ip6tables/ip subcommands, and
 *   - IP literals produced by inet_ntop() (never user input),
 * so /bin/sh -c is acceptable here.
 */
static int run_cmd(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    if (n < 0 || (size_t)n >= sizeof(buf)) {
        fprintf(stderr, "run_cmd: format error or truncation\n");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "run_cmd fork: %s\n", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        execlp("/bin/sh", "sh", "-c", buf, (char *)NULL);
        fprintf(stderr, "run_cmd execlp: %s\n", strerror(errno));
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        fprintf(stderr, "run_cmd waitpid: %s\n", strerror(errno));
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "run_cmd non-zero exit: %s\n", buf);
        return -1;
    }
    return 0;
}

/*
 * --allow ... -- <argv...>
 *
 * Parse hostnames, resolve them, unshare(CLONE_NEWNET), install iptables
 * default-DROP OUTPUT chain plus per-resolved-IP TCP/443 ACCEPT rules,
 * drop all capabilities, install post-unshare seccomp, then execv() the
 * remainder of argv (typically `bwrap --share-net ... connector-entry`).
 *
 * Namespace isolation guarantee:
 *   - The helper creates a fresh network namespace via unshare(CLONE_NEWNET)
 *     and immediately installs OUTPUT-default-DROP. The host-side veth
 *     peer (nb-out-<pid>) is, by Linux design, owned by the host's netns
 *     and therefore invisible to anything running inside this new netns.
 *   - The connector inside also lacks CAP_NET_ADMIN against the host user
 *     namespace because bwrap is invoked with --unshare-user — so even if
 *     a confused-deputy inside the connector tries to call netlink to
 *     manipulate routes, it cannot.
 *   - The veth pair itself is **out of scope for the helper in PR 1**.
 *     The helper relies on bwrap's existing routing (--share-net in the
 *     calling Bun process establishes the upstream path before unshare);
 *     a follow-up PR will add a dedicated nb-out-<pid> veth pair owned
 *     by the host's netns.
 */
static int mode_enforce_and_exec(int argc, char **argv) {
    /* Parse --allow <host> [--allow <host> ...] until -- */
    const char *allowed[MAX_HOSTS];
    int n_allowed = 0;
    int i = 1;
    while (i < argc && strcmp(argv[i], "--") != 0) {
        if (strcmp(argv[i], "--allow") != 0) {
            fprintf(stderr, "unexpected arg: %s\n", argv[i]);
            return 2;
        }
        if (i + 1 >= argc) {
            fprintf(stderr, "--allow requires a value\n");
            return 2;
        }
        const char *host = argv[i + 1];
        if (!valid_hostname(host)) {
            fprintf(stderr, "invalid hostname: %s\n", host);
            return 2;
        }
        if (n_allowed >= MAX_HOSTS) {
            fprintf(stderr, "too many --allow flags (max %d)\n", MAX_HOSTS);
            return 2;
        }
        allowed[n_allowed++] = host;
        i += 2;
    }
    if (i >= argc || strcmp(argv[i], "--") != 0) {
        fprintf(stderr, "expected -- followed by child argv\n");
        return 2;
    }
    char **child_argv = &argv[i + 1];
    if (child_argv[0] == NULL) {
        fprintf(stderr, "child argv is empty\n");
        return 2;
    }

    /* Step 1: resolve each host before any kernel-state change so DNS
     * failures surface as exit code 3 without leaving the helper inside
     * a half-configured netns. */
    struct addrinfo *resolved[MAX_HOSTS];
    for (int k = 0; k < n_allowed; k++) {
        resolved[k] = NULL;
    }
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;       /* IPv4 + IPv6 */
    hints.ai_socktype = SOCK_STREAM;
    for (int k = 0; k < n_allowed; k++) {
        int rc = getaddrinfo(allowed[k], "443", &hints, &resolved[k]);
        if (rc != 0 || resolved[k] == NULL) {
            fprintf(stderr, "getaddrinfo(%s): %s\n", allowed[k], gai_strerror(rc));
            for (int j = 0; j < k; j++) {
                if (resolved[j]) freeaddrinfo(resolved[j]);
            }
            return 3;
        }
    }

    /* Step 2: create the network namespace. After this point the helper is
     * inside a fresh, empty netns with no interfaces except a down `lo`. */
    if (unshare(CLONE_NEWNET) != 0) {
        fprintf(stderr, "unshare(CLONE_NEWNET) failed: %s\n", strerror(errno));
        for (int k = 0; k < n_allowed; k++) {
            if (resolved[k]) freeaddrinfo(resolved[k]);
        }
        return 4;
    }

    /* Step 3: bring loopback up and install the iptables/ip6tables ruleset.
     * The helper still holds CAP_NET_ADMIN in this netns; CAP_NET_ADMIN is
     * dropped immediately after the rules are installed.
     *
     * Every `return 5` from here through the per-IP loop below must release
     * resolved[] via free_all_resolved(); the addrinfo chains were allocated
     * in step 1 and are not freed until after the per-IP loop finishes. */
    if (run_cmd("ip link set lo up") != 0) { free_all_resolved(resolved, n_allowed); return 5; }

    /* Default-DROP OUTPUT on both v4 and v6 — nothing leaves the netns
     * unless explicitly allowed below. */
    if (run_cmd("iptables -P OUTPUT DROP") != 0) { free_all_resolved(resolved, n_allowed); return 5; }
    if (run_cmd("ip6tables -P OUTPUT DROP") != 0) { free_all_resolved(resolved, n_allowed); return 5; }

    /* Accept ESTABLISHED,RELATED so return traffic on already-accepted
     * connections is not silently dropped. */
    if (run_cmd("iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }
    if (run_cmd("ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }

    /* Accept DNS on UDP and TCP port 53 so the connector can resolve
     * additional hostnames inside its own DNS cycle. */
    if (run_cmd("iptables -A OUTPUT -p udp --dport 53 -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }
    if (run_cmd("iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }
    if (run_cmd("ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }
    if (run_cmd("ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT") != 0) { free_all_resolved(resolved, n_allowed); return 5; }

    /* Per-host TCP/443 ACCEPT rules — one per resolved A / AAAA record.
     * Every early `return 5` inside this loop must release resolved[]; use
     * free_all_resolved() so the cleanup is centralized and audited. */
    for (int k = 0; k < n_allowed; k++) {
        for (struct addrinfo *ai = resolved[k]; ai != NULL; ai = ai->ai_next) {
            char ipstr[INET6_ADDRSTRLEN];
            if (ai->ai_family == AF_INET) {
                void *addr_ptr = &((struct sockaddr_in *)ai->ai_addr)->sin_addr;
                if (inet_ntop(AF_INET, addr_ptr, ipstr, sizeof(ipstr)) == NULL) {
                    fprintf(stderr, "inet_ntop(AF_INET) failed: %s\n", strerror(errno));
                    free_all_resolved(resolved, n_allowed);
                    return 5;
                }
                if (run_cmd("iptables -A OUTPUT -d %s -p tcp --dport 443 -j ACCEPT", ipstr) != 0) {
                    free_all_resolved(resolved, n_allowed);
                    return 5;
                }
            } else if (ai->ai_family == AF_INET6) {
                void *addr_ptr = &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
                if (inet_ntop(AF_INET6, addr_ptr, ipstr, sizeof(ipstr)) == NULL) {
                    fprintf(stderr, "inet_ntop(AF_INET6) failed: %s\n", strerror(errno));
                    free_all_resolved(resolved, n_allowed);
                    return 5;
                }
                if (run_cmd("ip6tables -A OUTPUT -d %s -p tcp --dport 443 -j ACCEPT", ipstr) != 0) {
                    free_all_resolved(resolved, n_allowed);
                    return 5;
                }
            }
            /* silently skip families we don't handle (e.g. AF_UNIX from a
             * misconfigured nss module) — the default-DROP catches them. */
        }
    }
    /* Free DNS results — we no longer need them past this point. */
    free_all_resolved(resolved, n_allowed);

    /* Step 4: drop all capabilities. Past this point the helper (and the
     * to-be-execed bwrap/connector chain) cannot call CAP_NET_ADMIN-gated
     * syscalls such as additional iptables manipulation, even if seccomp
     * somehow allowed them. */
    cap_t empty = cap_init();
    if (!empty) {
        fprintf(stderr, "cap_init failed: %s\n", strerror(errno));
        return 6;
    }
    if (cap_set_proc(empty) != 0) {
        fprintf(stderr, "cap_set_proc(empty) failed: %s\n", strerror(errno));
        cap_free(empty);
        return 6;
    }
    cap_free(empty);

    /* Step 5: install the post-unshare seccomp filter. This is the proof
     * that the helper cannot itself escape the netns — even with a future
     * code-level bug, setns and unshare are kernel-side denied. The filter
     * is inherited across execv per kernel docs. */
    if (install_post_unshare_seccomp() != 0) {
        fprintf(stderr, "post-unshare seccomp install failed\n");
        return 7;
    }

    /* Step 6: exec the supplied argv (typically bwrap ... connector). */
    execv(child_argv[0], child_argv);
    fprintf(stderr, "execv(%s) failed: %s\n", child_argv[0], strerror(errno));
    return 127;
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr,
            "usage:\n"
            "  %s --check-caps\n"
            "  %s --allow <host> [--allow <host> ...] -- <argv...>\n",
            argv[0], argv[0]);
        return 2;
    }
    if (strcmp(argv[1], "--check-caps") == 0) {
        return mode_check_caps();
    }
    if (strcmp(argv[1], "--allow") == 0) {
        return mode_enforce_and_exec(argc, argv);
    }
    fprintf(stderr, "unknown mode: %s\n", argv[1]);
    return 2;
}

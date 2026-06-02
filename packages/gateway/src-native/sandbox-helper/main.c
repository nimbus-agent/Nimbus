/*
 * nimbus-sandbox-helper — Linux-only post-bwrap network confinement.
 *
 * Modes:
 *   --check-caps           — verify CAP_NET_ADMIN is in the permitted set
 *                            (used at install-time by `nimbus doctor` and in CI).
 *
 *   --allow <host[:port]> [...]  -- <argv...>
 *                          — resolve each <host>, unshare(CLONE_NEWNET), install
 *                            an iptables/ip6tables OUTPUT-default-DROP ruleset
 *                            that only permits the resolved IPs on each host's
 *                            declared TCP port (a bare host defaults to 443; an
 *                            explicit `host:port` such as imap.example.com:993
 *                            opens that port instead) plus DNS UDP/TCP 53 and
 *                            ESTABLISHED,RELATED, drop all
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
/*
 * Validate a single dot-free DNS label spanning label[0 .. len-1]: length
 * 1..63, characters in [A-Za-z0-9-], no leading or trailing hyphen. An empty
 * label (len == 0) is rejected, which is how valid_hostname below turns a
 * leading/trailing dot or consecutive dots into a rejection.
 * Returns 1 on accept, 0 on reject.
 */
static int valid_label(const char *label, size_t len) {
    if (len == 0 || len > 63) {
        return 0;
    }
    if (label[0] == '-' || label[len - 1] == '-') {
        return 0;
    }
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)label[i];
        int is_alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                       (c >= '0' && c <= '9');
        if (!is_alnum && c != '-') {
            return 0;
        }
    }
    return 1;
}

static int valid_hostname(const char *host) {
    if (host == NULL) {
        return 0;
    }
    size_t len = strlen(host);
    if (len == 0 || len > 253) {
        return 0;
    }
    /* Walk the dot-separated labels; the sentinel index i == len closes the
     * final label so the trailing-dot / final-label cases reuse valid_label. */
    size_t label_start = 0;
    for (size_t i = 0; i <= len; i++) {
        if (i == len || host[i] == '.') {
            if (!valid_label(host + label_start, i - label_start)) {
                return 0;
            }
            label_start = i + 1;
        }
    }
    return 1;
}

/*
 * Parse a decimal TCP port (1..65535) from `s`. Accepts 1..5 ASCII digits with
 * no sign, whitespace, or other characters. Returns the port on success, or -1
 * on any malformed input. Mirrors the TypeScript `permissions.network` port
 * check (/^\d{1,5}$/ + 1..65535) in permissions-validator.ts so both ends of
 * the pipeline (TOML loader + helper argv) enforce the same contract.
 */
static int parse_port(const char *s) {
    if (s == NULL || s[0] == '\0') {
        return -1;
    }
    long val = 0;
    for (const char *p = s; *p != '\0'; p++) {
        if (*p < '0' || *p > '9') {
            return -1;
        }
        val = val * 10 + (*p - '0');
        if (val > 65535) {
            return -1;
        }
    }
    if (val < 1) {
        return -1;
    }
    return (int)val;
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
        /* load seccomp_data.arch (struct offset 4) into the accumulator */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, 4),

        /* if arch == AUDIT_ARCH_X86_64 (0xC000003E), skip the kill (jt=1);
         * else fall through (jf=0) to KILL_PROCESS. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),

        /* load seccomp_data.nr (struct offset 0) into the accumulator */
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
 * Wrapper around `/bin/sh -c <cmd>`. Returns 0 on clean success, or -1 on any
 * non-zero exit or fork/exec failure. Callers build the command string first
 * (see add_host_accept_rules for the only formatted call site); run_cmd takes
 * a finished string so the format string handed to the formatter is always a
 * literal at the build site, never run_cmd's own argument.
 *
 * The helper passes only well-validated values into <cmd>:
 *   - hardcoded iptables/ip6tables/ip subcommands, and
 *   - IP literals produced by inet_ntop() (never user input),
 * so /bin/sh -c is acceptable here.
 */
static int run_cmd(const char *cmd) {
    pid_t pid = fork();
    if (pid < 0) {
        fprintf(stderr, "run_cmd fork: %s\n", strerror(errno));
        return -1;
    }
    if (pid == 0) {
        execlp("/bin/sh", "sh", "-c", cmd, (char *)NULL);
        fprintf(stderr, "run_cmd execlp: %s\n", strerror(errno));
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        fprintf(stderr, "run_cmd waitpid: %s\n", strerror(errno));
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "run_cmd non-zero exit: %s\n", cmd);
        return -1;
    }
    return 0;
}

/*
 * Parse the `--allow <host[:port]> ... -- <argv...>` portion of argv. On success
 * returns 0 with allowed[] (host only) + ports[] (parsed TCP port, default 443)
 * / *n_allowed_out populated and *child_argv_out pointing at the post-`--` child
 * argv. On any parse error prints a diagnostic and returns 2.
 *
 * A `host:port` value is split in place: the colon in the writable argv string
 * is overwritten with a NUL so allowed[k] becomes the bare host, and the port
 * substring is validated via parse_port. A bare host gets the default port 443.
 */
static int parse_allowed_hosts(int argc, char **argv, const char **allowed,
                               int *ports, int *n_allowed_out, char ***child_argv_out) {
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
        char *value = argv[i + 1];
        int port = 443;
        /* Hostnames never contain a colon, so the last colon (if any) separates
         * host from port. Split in place: argv strings are writable. */
        char *colon = strrchr(value, ':');
        if (colon != NULL) {
            port = parse_port(colon + 1);
            if (port < 0) {
                fprintf(stderr, "invalid port: %s\n", value);
                return 2;
            }
            *colon = '\0';
        }
        if (!valid_hostname(value)) {
            fprintf(stderr, "invalid hostname: %s\n", value);
            return 2;
        }
        if (n_allowed >= MAX_HOSTS) {
            fprintf(stderr, "too many --allow flags (max %d)\n", MAX_HOSTS);
            return 2;
        }
        ports[n_allowed] = port;
        allowed[n_allowed++] = value;
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
    *n_allowed_out = n_allowed;
    *child_argv_out = child_argv;
    return 0;
}

/*
 * Resolve every allowed host to an addrinfo chain in resolved[]. Done before
 * any kernel-state change so DNS failures surface as exit code 3 without
 * leaving a half-configured netns. On failure frees the partial set it
 * allocated (resolved[0 .. k-1]) and returns 3; on success returns 0 with
 * every resolved[k] non-NULL.
 */
static int resolve_allowed_hosts(const char **allowed, int n_allowed,
                                 struct addrinfo **resolved) {
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
            free_all_resolved(resolved, k);
            return 3;
        }
    }
    return 0;
}

/*
 * Install the per-resolved-IP TCP ACCEPT rules for one host's addrinfo chain on
 * the host's declared `port`. Returns 0, or 5 on an inet_ntop / run_cmd failure.
 * Does not free `ai` — ownership stays with the caller. Families other than
 * AF_INET / AF_INET6 are silently skipped (the default-DROP policy still covers
 * them). `port` is a validated 1..65535 value (see parse_port), so it is safe to
 * interpolate into the iptables command.
 */
static int add_host_accept_rules(struct addrinfo *ai, int port) {
    for (; ai != NULL; ai = ai->ai_next) {
        char ipstr[INET6_ADDRSTRLEN];
        char cmd[128];
        if (ai->ai_family == AF_INET) {
            const void *addr_ptr = &((struct sockaddr_in *)ai->ai_addr)->sin_addr;
            if (inet_ntop(AF_INET, addr_ptr, ipstr, sizeof(ipstr)) == NULL) {
                fprintf(stderr, "inet_ntop(AF_INET) failed: %s\n", strerror(errno));
                return 5;
            }
            int n = snprintf(cmd, sizeof(cmd),
                             "iptables -A OUTPUT -d %s -p tcp --dport %d -j ACCEPT", ipstr, port);
            if (n < 0 || (size_t)n >= sizeof(cmd)) {
                fprintf(stderr, "add_host_accept_rules: command truncated\n");
                return 5;
            }
            if (run_cmd(cmd) != 0) {
                return 5;
            }
        } else if (ai->ai_family == AF_INET6) {
            const void *addr_ptr = &((struct sockaddr_in6 *)ai->ai_addr)->sin6_addr;
            if (inet_ntop(AF_INET6, addr_ptr, ipstr, sizeof(ipstr)) == NULL) {
                fprintf(stderr, "inet_ntop(AF_INET6) failed: %s\n", strerror(errno));
                return 5;
            }
            int n = snprintf(cmd, sizeof(cmd),
                             "ip6tables -A OUTPUT -d %s -p tcp --dport %d -j ACCEPT", ipstr, port);
            if (n < 0 || (size_t)n >= sizeof(cmd)) {
                fprintf(stderr, "add_host_accept_rules: command truncated\n");
                return 5;
            }
            if (run_cmd(cmd) != 0) {
                return 5;
            }
        }
        /* silently skip families we don't handle (e.g. AF_UNIX from a
         * misconfigured nss module) — the default-DROP catches them. */
    }
    return 0;
}

/*
 * Bring loopback up and install the default-DROP OUTPUT ruleset (v4+v6) plus
 * ESTABLISHED,RELATED, DNS/53, and the per-resolved-IP per-host-port TCP ACCEPT
 * rules. Returns 0, or 5 on the first failure. Does not free resolved[] — the
 * caller owns it and frees it unconditionally afterwards.
 */
static int install_firewall_rules(struct addrinfo **resolved, const int *ports,
                                  int n_allowed) {
    if (run_cmd("ip link set lo up") != 0) return 5;

    /* Default-DROP OUTPUT on both v4 and v6 — nothing leaves the netns unless
     * explicitly allowed below. */
    if (run_cmd("iptables -P OUTPUT DROP") != 0) return 5;
    if (run_cmd("ip6tables -P OUTPUT DROP") != 0) return 5;

    /* Accept ESTABLISHED,RELATED so return traffic on already-accepted
     * connections is not silently dropped. */
    if (run_cmd("iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT") != 0) return 5;
    if (run_cmd("ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT") != 0) return 5;

    /* Accept DNS on UDP and TCP port 53 so the connector can resolve
     * additional hostnames inside its own DNS cycle. */
    if (run_cmd("iptables -A OUTPUT -p udp --dport 53 -j ACCEPT") != 0) return 5;
    if (run_cmd("iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT") != 0) return 5;
    if (run_cmd("ip6tables -A OUTPUT -p udp --dport 53 -j ACCEPT") != 0) return 5;
    if (run_cmd("ip6tables -A OUTPUT -p tcp --dport 53 -j ACCEPT") != 0) return 5;

    /* Per-host TCP ACCEPT rules on each host's declared port — one per resolved
     * A / AAAA record. */
    for (int k = 0; k < n_allowed; k++) {
        int rc = add_host_accept_rules(resolved[k], ports[k]);
        if (rc != 0) {
            return rc;
        }
    }
    return 0;
}

/*
 * Drop all capabilities (CAP_NET_ADMIN included) before exec, so neither the
 * helper nor the to-be-execed bwrap/connector chain can call CAP_NET_ADMIN-gated
 * syscalls even if seccomp somehow allowed them. Returns 0 or 6.
 */
static int drop_all_caps(void) {
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
    return 0;
}

/*
 * --allow ... -- <argv...>
 *
 * Parse hostnames + ports, resolve them, unshare(CLONE_NEWNET), install iptables
 * default-DROP OUTPUT chain plus per-resolved-IP per-host-port TCP ACCEPT rules,
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
    /* Step 0: parse `--allow <host[:port]> ... -- <argv...>`. */
    const char *allowed[MAX_HOSTS];
    int ports[MAX_HOSTS];
    int n_allowed = 0;
    char **child_argv = NULL;
    int rc = parse_allowed_hosts(argc, argv, allowed, ports, &n_allowed, &child_argv);
    if (rc != 0) {
        return rc;
    }

    /* Step 1: resolve each host before any kernel-state change so DNS
     * failures surface as exit code 3 without leaving the helper inside a
     * half-configured netns. resolve_allowed_hosts frees its own partial set
     * on failure. */
    struct addrinfo *resolved[MAX_HOSTS];
    rc = resolve_allowed_hosts(allowed, n_allowed, resolved);
    if (rc != 0) {
        return rc;
    }

    /* Step 2: create the network namespace. After this point the helper is
     * inside a fresh, empty netns with no interfaces except a down `lo`. */
    if (unshare(CLONE_NEWNET) != 0) {
        fprintf(stderr, "unshare(CLONE_NEWNET) failed: %s\n", strerror(errno));
        free_all_resolved(resolved, n_allowed);
        return 4;
    }

    /* Step 3: install the iptables/ip6tables ruleset. resolved[] is consumed
     * here and freed unconditionally on return — both the failure and success
     * paths release it, preserving the original "free on every branch"
     * guarantee by construction. The helper still holds CAP_NET_ADMIN in this
     * netns; it is dropped immediately after the rules are installed. */
    rc = install_firewall_rules(resolved, ports, n_allowed);
    free_all_resolved(resolved, n_allowed);
    if (rc != 0) {
        return rc;
    }

    /* Step 4: drop all capabilities. Past this point the helper (and the
     * to-be-execed bwrap/connector chain) cannot call CAP_NET_ADMIN-gated
     * syscalls such as additional iptables manipulation, even if seccomp
     * somehow allowed them. */
    rc = drop_all_caps();
    if (rc != 0) {
        return rc;
    }

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
            "  %s --allow <host[:port]> [--allow <host[:port]> ...] -- <argv...>\n",
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

/*
 * nimbus-sandbox-helper: the launcher and forwarder of Linux per-host networking.
 *
 * It runs inside the outer bwrap's new user and network namespaces, as uid 0 there, holding
 * CAP_NET_BIND_SERVICE, CAP_SETPCAP and CAP_SETFCAP. It binds the sandbox's loopback listeners,
 * forks the forwarder, and becomes the inner bwrap.
 *
 * The forwarder drops everything, then relays bytes between those listeners and the unix socket of
 * the wrapper outside the sandbox. It handles bytes a hostile child wrote, so it parses none of
 * them, holds no capability, and runs under its own seccomp allowlist. It knows nothing about the
 * policy: a compromised forwarder can name any entry index, and the wrapper checks every one.
 *
 * Modes:
 *   --check
 *       Prints OK and exits 0. No capability, namespace or file work.
 *
 *   --socket <path> [--alias <ip>]... --listen <ip>:<port>:<index>... --dns <ip> -- <argv...>
 *       <path>   the wrapper's unix socket.
 *       --alias  adds an IPv4 address to `lo`, for an IP-literal entry. Needs CAP_NET_ADMIN.
 *       --listen one TCP listener; <index> is the wrapper's entry index, 0..65535.
 *       --dns    the address whose UDP port 53 carries the stub resolver's datagrams.
 *
 * Wire format, one per unix connection (packages/gateway/src/platform/sandbox/net-forward-host.ts):
 * a 3-byte header, then the stream. Byte 0 is `T` or `D`, bytes 1 and 2 the big-endian entry index
 * (0 for `D`). `T` relays until either side closes. `D` writes a 2-byte big-endian length and a
 * datagram, reads a 2-byte length and the reply, and closes.
 *
 * Exit codes: 0 --check; 2 usage; 3 bind, listen or fork failure; 5 alias failure; 6 the forwarder
 * could not lock itself down, so nothing started; 127 exec failure.
 * Stderr carries only those startup failures. Nothing is ever logged about a connection, and the
 * forwarder's stderr is /dev/null.
 *
 * Build: `make` in this directory. C99, -Werror clean, static, x86-64 only.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>

#ifndef __x86_64__
#error "the forwarder's seccomp allowlist names x86-64 syscalls; add this architecture's first"
#endif

#define EXIT_USAGE 2
#define EXIT_BIND 3
#define EXIT_ALIAS 5
#define EXIT_LOCKDOWN 6
#define EXIT_EXEC 127

#define MAX_ENTRIES 65535u
#define MAX_PORT 65535ul
#define MAX_INDEX 65535ul
#define DNS_PORT 53

/* The inner bwrap's seccomp program. The launcher keeps it for the exec; the forwarder closes it. */
#define INNER_SECCOMP_FD 3

#define MAX_RELAYS 512u
#define RELAY_BUFFER_BYTES 16384
#define MAX_DATAGRAM_BYTES 4096
#define DNS_REPLY_TIMEOUT_MS 5000

#define HEADER_BYTES 3
#define DNS_LENGTH_BYTES 2

typedef struct {
    struct in_addr ip;
    const char *ip_text;
    const char *port_text;
    uint16_t port;
    uint16_t index;
    int fd;
} listener_t;

typedef struct {
    struct in_addr ip;
    const char *text;
} address_t;

typedef struct {
    const char *socket_path;
    address_t *aliases;
    size_t alias_count;
    listener_t *listeners;
    size_t listener_count;
    address_t dns;
    bool has_dns;
    char **child_argv;
} options_t;

/* ------------------------------------------------------------------ argument parsing */

/* Decimal digits only, at most `max`. No sign, no whitespace, and no value from an overflow. */
static bool parse_decimal(const char *s, unsigned long max, unsigned long *out) {
    if (*s == '\0') {
        return false;
    }
    unsigned long value = 0;
    for (const char *p = s; *p != '\0'; p++) {
        if (*p < '0' || *p > '9') {
            return false;
        }
        value = value * 10 + (unsigned long)(*p - '0');
        if (value > max) {
            return false;
        }
    }
    *out = value;
    return true;
}

/* <ip>:<port>:<index>. Splits the writable argv string in place. */
static bool parse_listen(char *value, listener_t *out) {
    char *last_colon = strrchr(value, ':');
    if (last_colon == NULL) {
        return false;
    }
    *last_colon = '\0';
    char *port_colon = strrchr(value, ':');
    if (port_colon == NULL) {
        return false;
    }
    *port_colon = '\0';
    unsigned long port = 0;
    unsigned long index = 0;
    if (!parse_decimal(port_colon + 1, MAX_PORT, &port) || port == 0) {
        return false;
    }
    if (!parse_decimal(last_colon + 1, MAX_INDEX, &index)) {
        return false;
    }
    if (inet_pton(AF_INET, value, &out->ip) != 1) {
        return false;
    }
    out->ip_text = value;
    out->port_text = port_colon + 1;
    out->port = (uint16_t)port;
    out->index = (uint16_t)index;
    out->fd = -1;
    return true;
}

static bool parse_address(const char *value, address_t *out) {
    out->text = value;
    return inet_pton(AF_INET, value, &out->ip) == 1;
}

static bool parse_socket_path(const char *value, const char **out) {
    if (*out != NULL || value[0] == '\0') {
        return false;
    }
    if (strlen(value) >= sizeof(((struct sockaddr_un *)NULL)->sun_path)) {
        return false;
    }
    *out = value;
    return true;
}

/* One `--flag value` pair. False on anything unknown, repeated, malformed or over a limit. */
static bool parse_flag(const char *flag, char *value, options_t *o) {
    if (strcmp(flag, "--socket") == 0) {
        return parse_socket_path(value, &o->socket_path);
    }
    if (strcmp(flag, "--alias") == 0) {
        if (o->alias_count >= MAX_ENTRIES) {
            return false;
        }
        return parse_address(value, &o->aliases[o->alias_count++]);
    }
    if (strcmp(flag, "--listen") == 0) {
        if (o->listener_count >= MAX_ENTRIES) {
            return false;
        }
        return parse_listen(value, &o->listeners[o->listener_count++]);
    }
    if (strcmp(flag, "--dns") == 0) {
        if (o->has_dns) {
            return false;
        }
        o->has_dns = true;
        return parse_address(value, &o->dns);
    }
    return false;
}

static bool parse_args(int argc, char **argv, options_t *o) {
    size_t slots = (size_t)argc;
    o->aliases = calloc(slots, sizeof(*o->aliases));
    o->listeners = calloc(slots, sizeof(*o->listeners));
    if (o->aliases == NULL || o->listeners == NULL) {
        return false;
    }
    int i = 1;
    while (i < argc && strcmp(argv[i], "--") != 0) {
        if (i + 1 >= argc || !parse_flag(argv[i], argv[i + 1], o)) {
            return false;
        }
        i += 2;
    }
    if (i + 1 >= argc) { /* no `--`, or nothing after it */
        return false;
    }
    o->child_argv = &argv[i + 1];
    return o->socket_path != NULL && o->listener_count > 0 && o->has_dns;
}

/* ------------------------------------------------------------------ the launcher */

/*
 * The forwarder closes 0 to 3 by number, so no socket may land there. A number nothing holds gets
 * a close-on-exec /dev/null, which the exec removes again, so the child sees what it would have.
 */
static bool reserve_low_fds(void) {
    for (int fd = 0; fd <= INNER_SECCOMP_FD; fd++) {
        if (fcntl(fd, F_GETFD) < 0 && open("/dev/null", O_RDWR | O_CLOEXEC) != fd) {
            return false;
        }
    }
    return true;
}

static struct sockaddr_in inet_address(struct in_addr ip, uint16_t port) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr = ip;
    return address;
}

static int set_interface_address(int fd, unsigned long request, const char *label,
                                 struct in_addr ip) {
    struct ifreq request_data;
    memset(&request_data, 0, sizeof(request_data));
    memcpy(request_data.ifr_name, label, strlen(label) + 1);
    struct sockaddr_in address = inet_address(ip, 0);
    memcpy(&request_data.ifr_addr, &address, sizeof(address));
    return ioctl(fd, request, &request_data);
}

/*
 * Each alias gets a /32. SIOCSIFADDR alone assigns the old classful netmask, and on `lo` that makes
 * a whole /8 local, where the child could bind any address the policy never named.
 */
static int apply_aliases(const options_t *o) {
    if (o->alias_count == 0) {
        return 0;
    }
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        fprintf(stderr, "nimbus-sandbox-helper: alias socket: %s\n", strerror(errno));
        return EXIT_ALIAS;
    }
    struct in_addr host_mask;
    host_mask.s_addr = INADDR_NONE;
    for (size_t i = 0; i < o->alias_count; i++) {
        char label[IFNAMSIZ];
        int written = snprintf(label, sizeof(label), "lo:%zu", i);
        if (written < 0 || (size_t)written >= sizeof(label) ||
            set_interface_address(fd, SIOCSIFADDR, label, o->aliases[i].ip) != 0 ||
            set_interface_address(fd, SIOCSIFNETMASK, label, host_mask) != 0) {
            fprintf(stderr, "nimbus-sandbox-helper: alias %s: %s\n", o->aliases[i].text,
                    strerror(errno));
            close(fd);
            return EXIT_ALIAS;
        }
    }
    close(fd);
    return 0;
}

static int bind_listeners(const options_t *o) {
    for (size_t i = 0; i < o->listener_count; i++) {
        listener_t *l = &o->listeners[i];
        struct sockaddr_in address = inet_address(l->ip, l->port);
        /* Nonblocking, since a connection can vanish between the poll and the accept. */
        l->fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
        if (l->fd < 0 || bind(l->fd, (const struct sockaddr *)&address, sizeof(address)) != 0 ||
            listen(l->fd, SOMAXCONN) != 0) {
            fprintf(stderr, "nimbus-sandbox-helper: bind %s:%s: %s\n", l->ip_text, l->port_text,
                    strerror(errno));
            return EXIT_BIND;
        }
    }
    return 0;
}

static int bind_dns(const options_t *o) {
    struct sockaddr_in address = inet_address(o->dns.ip, DNS_PORT);
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0 || bind(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
        fprintf(stderr, "nimbus-sandbox-helper: bind %s:%d: %s\n", o->dns.text, DNS_PORT,
                strerror(errno));
        return -1;
    }
    return fd;
}

/* ------------------------------------------------------------------ the forwarder's lockdown */

static bool set_signal(int signum, void (*handler)(int)) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = handler;
    return sigaction(signum, &action, NULL) == 0;
}

static bool replace_stdio(void) {
    for (int fd = 0; fd <= INNER_SECCOMP_FD; fd++) {
        close(fd);
    }
    /* Each open takes the lowest free number, so this is 0, 1 and 2 in turn. */
    for (int fd = 0; fd <= STDERR_FILENO; fd++) {
        if (open("/dev/null", O_RDWR) != fd) {
            return false;
        }
    }
    return true;
}

static bool drop_capabilities(void) {
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) {
        return false;
    }
    /* The kernel's highest capability is not known at build time: EINVAL marks the end. */
    for (unsigned long cap = 0; cap < 64; cap++) {
        if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0) != 0) {
            if (errno == EINVAL) {
                break;
            }
            return false;
        }
    }
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[_LINUX_CAPABILITY_U32S_3];
    memset(data, 0, sizeof(data));
    if (syscall(SYS_capset, &header, data) != 0) {
        return false;
    }
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0;
}

#define SECCOMP_ARCH_OFFSET ((uint32_t)offsetof(struct seccomp_data, arch))
#define SECCOMP_NR_OFFSET ((uint32_t)offsetof(struct seccomp_data, nr))
/* The low 32 bits, on this little-endian architecture. The kernel reads `socket`'s domain as int. */
#define SECCOMP_ARG0_OFFSET ((uint32_t)offsetof(struct seccomp_data, args[0]))

#define LOAD(offset) BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (offset))
#define KILL BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS)
#define ALLOW_RET BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
#define ALLOW(nr) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), ALLOW_RET

/* A new namespace would escape the outer bwrap's view, so a thread or process may not ask for one. */
#define CLONE_NAMESPACE_FLAGS                                                                      \
    (CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWIPC | CLONE_NEWUTS |     \
     CLONE_NEWCGROUP | CLONE_NEWTIME)

/*
 * Anything not named here kills the process. Nothing here opens a file, and `socket` is AF_UNIX
 * only, so a compromised forwarder cannot open a route. It runs after /dev/null is open.
 *
 * This does not bound which unix sockets it reaches: `connect` takes any path it can see. What
 * bounds that is the outer bwrap's view, which must never show it the host's sockets, the gateway's
 * among them. A change to that view is a change to this boundary.
 *
 * seccomp-harness.c tests this list, and repeats it on purpose. Change both.
 */
static bool install_seccomp(void) {
    struct sock_filter filter[] = {
        LOAD(SECCOMP_ARCH_OFFSET),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        KILL,
        LOAD(SECCOMP_NR_OFFSET),

        /* socket: only AF_UNIX. Both arms return, so the reload of A touches nothing below. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4),
        LOAD(SECCOMP_ARG0_OFFSET),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
        ALLOW_RET,
        KILL,

        /* clone: no namespace flag, read from the low word of arg0 as the kernel does. Both return. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4),
        LOAD(SECCOMP_ARG0_OFFSET),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, CLONE_NAMESPACE_FLAGS, 0, 1),
        KILL,
        ALLOW_RET,

        /* clone3's flags live in user memory, where a filter cannot read them. libc falls back. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone3, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ENOSYS),

        ALLOW(SYS_read),
        ALLOW(SYS_write),
        ALLOW(SYS_close),
        ALLOW(SYS_shutdown),
        ALLOW(SYS_poll),
        ALLOW(SYS_ppoll),
        ALLOW(SYS_accept),
        ALLOW(SYS_accept4),
        ALLOW(SYS_connect),
        ALLOW(SYS_sendto),
        ALLOW(SYS_recvfrom),
        ALLOW(SYS_fcntl),
        ALLOW(SYS_wait4),
        ALLOW(SYS_exit),
        ALLOW(SYS_exit_group),
        ALLOW(SYS_rt_sigaction),
        ALLOW(SYS_rt_sigreturn),
        ALLOW(SYS_rt_sigprocmask),
        ALLOW(SYS_brk),
        ALLOW(SYS_mmap),
        ALLOW(SYS_munmap),
        ALLOW(SYS_getpid),
        ALLOW(SYS_set_robust_list), /* glibc's fork calls it in the child */
        ALLOW(SYS_restart_syscall), /* resumes a poll that a stop and continue interrupted */

        KILL,
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
        .filter = filter,
    };
    return syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program) == 0;
}

/* Each step needs the one before. Any failure leaves the forwarder gone and nothing relaying. */
static bool lock_down(pid_t launcher) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0) != 0 || getppid() != launcher) {
        return false;
    }
    /* An ignored SIGCHLD the launcher inherited would make `wait4` blind to the relays. */
    if (!set_signal(SIGCHLD, SIG_DFL) || !set_signal(SIGPIPE, SIG_IGN)) {
        return false;
    }
    return replace_stdio() && drop_capabilities() && install_seccomp();
}

/* ------------------------------------------------------------------ the relays */

/* Blocking. Null-terminated by the length check in parse_socket_path. */
static int connect_wrapper(const char *path) {
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    memcpy(address.sun_path, path, strlen(path) + 1);
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }
    while (connect(fd, (const struct sockaddr *)&address, sizeof(address)) != 0) {
        if (errno != EINTR) {
            close(fd);
            return -1;
        }
    }
    return fd;
}

static bool write_all(int fd, const unsigned char *bytes, size_t length) {
    size_t sent = 0;
    while (sent < length) {
        ssize_t n = write(fd, bytes + sent, length - sent);
        if (n > 0) {
            sent += (size_t)n;
        } else if (n < 0 && errno != EINTR) {
            return false;
        }
    }
    return true;
}

/* One direction of a relay. `shut` means its EOF has been passed on and its buffer is empty. */
typedef struct {
    int from;
    int to;
    size_t offset;
    size_t length;
    bool eof;
    bool shut;
    unsigned char buffer[RELAY_BUFFER_BYTES];
} stream_t;

static short read_interest(const stream_t *s) {
    return (!s->eof && s->length == 0) ? POLLIN : 0;
}

static short write_interest(const stream_t *s) {
    return s->length > 0 ? POLLOUT : 0;
}

static bool would_retry(void) {
    return errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK;
}

/* Moves whatever is ready in one direction. False when the relay is over. */
static bool service_stream(stream_t *s, short from_revents, short to_revents) {
    if (read_interest(s) != 0 && from_revents != 0) {
        ssize_t n = read(s->from, s->buffer, sizeof(s->buffer));
        if (n > 0) {
            s->offset = 0;
            s->length = (size_t)n;
        } else if (n == 0) {
            s->eof = true;
        } else if (!would_retry()) {
            return false;
        }
    }
    if (write_interest(s) != 0 && to_revents != 0) {
        ssize_t n = write(s->to, s->buffer + s->offset, s->length);
        if (n > 0) {
            s->offset += (size_t)n;
            s->length -= (size_t)n;
        } else if (n < 0 && !would_retry()) {
            return false;
        }
    }
    if (s->eof && s->length == 0 && !s->shut) {
        (void)shutdown(s->to, SHUT_WR);
        s->shut = true;
    }
    return true;
}

/*
 * Both directions at once, so neither side's flow can wait on the other's. A descriptor with no
 * interest goes in as -1, since poll reports POLLHUP regardless and would otherwise spin.
 */
static void relay_stream_pair(int a, int b) {
    stream_t a_to_b;
    stream_t b_to_a;
    memset(&a_to_b, 0, offsetof(stream_t, buffer));
    memset(&b_to_a, 0, offsetof(stream_t, buffer));
    a_to_b.from = a;
    a_to_b.to = b;
    b_to_a.from = b;
    b_to_a.to = a;

    while (!(a_to_b.shut && b_to_a.shut)) {
        short a_events = (short)(read_interest(&a_to_b) | write_interest(&b_to_a));
        short b_events = (short)(read_interest(&b_to_a) | write_interest(&a_to_b));
        struct pollfd fds[2] = {
            {a_events != 0 ? a : -1, a_events, 0},
            {b_events != 0 ? b : -1, b_events, 0},
        };
        if (poll(fds, 2, -1) < 0) {
            if (errno == EINTR) {
                continue;
            }
            return;
        }
        if (!service_stream(&a_to_b, fds[0].revents, fds[1].revents) ||
            !service_stream(&b_to_a, fds[1].revents, fds[0].revents)) {
            return;
        }
    }
}

static void relay_tcp(int accepted, uint16_t index, const char *socket_path) {
    const unsigned char header[HEADER_BYTES] = {'T', (unsigned char)(index >> 8),
                                                (unsigned char)(index & 0xff)};
    int wrapper = connect_wrapper(socket_path);
    if (wrapper < 0 || !write_all(wrapper, header, sizeof(header))) {
        return;
    }
    int flags = fcntl(wrapper, F_GETFL);
    if (flags < 0 || fcntl(wrapper, F_SETFL, flags | O_NONBLOCK) != 0) {
        return;
    }
    relay_stream_pair(accepted, wrapper);
}

/* Reads exactly `length` bytes, each wait bounded by the reply timeout. */
static bool read_reply(int fd, unsigned char *bytes, size_t length) {
    size_t got = 0;
    while (got < length) {
        struct pollfd pfd = {fd, POLLIN, 0};
        int ready = poll(&pfd, 1, DNS_REPLY_TIMEOUT_MS);
        if (ready == 0 || (ready < 0 && errno != EINTR)) {
            return false;
        }
        if (ready < 0) {
            continue;
        }
        ssize_t n = read(fd, bytes + got, length - got);
        if (n > 0) {
            got += (size_t)n;
        } else if (n == 0 || errno != EINTR) {
            return false;
        }
    }
    return true;
}

static void relay_datagram(int dns_fd, const char *socket_path, const unsigned char *datagram,
                           size_t length, const struct sockaddr_in *sender) {
    unsigned char frame[HEADER_BYTES + DNS_LENGTH_BYTES + MAX_DATAGRAM_BYTES];
    frame[0] = 'D';
    frame[1] = 0;
    frame[2] = 0;
    frame[3] = (unsigned char)(length >> 8);
    frame[4] = (unsigned char)(length & 0xff);
    memcpy(frame + HEADER_BYTES + DNS_LENGTH_BYTES, datagram, length);

    int wrapper = connect_wrapper(socket_path);
    if (wrapper < 0 || !write_all(wrapper, frame, HEADER_BYTES + DNS_LENGTH_BYTES + length)) {
        return;
    }
    unsigned char prefix[DNS_LENGTH_BYTES];
    if (!read_reply(wrapper, prefix, sizeof(prefix))) {
        return;
    }
    size_t reply_length = ((size_t)prefix[0] << 8) | prefix[1];
    unsigned char reply[MAX_DATAGRAM_BYTES];
    if (reply_length == 0 || reply_length > sizeof(reply) ||
        !read_reply(wrapper, reply, reply_length)) {
        return;
    }
    while (sendto(dns_fd, reply, reply_length, 0, (const struct sockaddr *)sender,
                  sizeof(*sender)) < 0 &&
           errno == EINTR) {
    }
}

/* ------------------------------------------------------------------ the poll loop */

static void close_listeners(const options_t *o) {
    for (size_t i = 0; i < o->listener_count; i++) {
        close(o->listeners[i].fd);
    }
}

static unsigned reap_relays(unsigned live) {
    while (live > 0 && wait4(-1, NULL, WNOHANG, NULL) > 0) {
        live--;
    }
    return live;
}

static unsigned serve_listener(const options_t *o, const listener_t *l, int dns_fd, unsigned live) {
    int accepted = accept4(l->fd, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (accepted < 0) {
        return live;
    }
    if (live >= MAX_RELAYS) {
        close(accepted);
        return live;
    }
    pid_t pid = fork();
    if (pid == 0) {
        close_listeners(o);
        close(dns_fd);
        relay_tcp(accepted, l->index, o->socket_path);
        _exit(0);
    }
    close(accepted);
    return pid > 0 ? live + 1 : live;
}

static unsigned serve_dns(const options_t *o, int dns_fd, unsigned live) {
    /* One byte over the limit, to tell a datagram that fits from one the kernel cut short. */
    unsigned char datagram[MAX_DATAGRAM_BYTES + 1];
    struct sockaddr_in sender;
    socklen_t sender_length = sizeof(sender);
    ssize_t n = recvfrom(dns_fd, datagram, sizeof(datagram), 0, (struct sockaddr *)&sender,
                         &sender_length);
    if (n <= 0 || n > MAX_DATAGRAM_BYTES || live >= MAX_RELAYS) {
        return live;
    }
    pid_t pid = fork();
    if (pid == 0) {
        close_listeners(o);
        relay_datagram(dns_fd, o->socket_path, datagram, (size_t)n, &sender);
        _exit(0);
    }
    return pid > 0 ? live + 1 : live;
}

static void forward(const options_t *o, int dns_fd) {
    size_t count = o->listener_count;
    struct pollfd *fds = calloc(count + 1, sizeof(*fds));
    if (fds == NULL) {
        return;
    }
    for (size_t i = 0; i < count; i++) {
        fds[i].fd = o->listeners[i].fd;
        fds[i].events = POLLIN;
    }
    fds[count].fd = dns_fd;
    fds[count].events = POLLIN;

    unsigned live = 0;
    for (;;) {
        if (poll(fds, count + 1, -1) < 0) {
            if (errno == EINTR) {
                continue;
            }
            return;
        }
        live = reap_relays(live);
        for (size_t i = 0; i < count; i++) {
            if (fds[i].revents != 0) {
                live = serve_listener(o, &o->listeners[i], dns_fd, live);
            }
        }
        if (fds[count].revents != 0) {
            live = serve_dns(o, dns_fd, live);
        }
    }
}

/* ------------------------------------------------------------------ entry */

/* True once the forwarder says it is locked down. EOF means it died first. */
static bool forwarder_locked_down(int ready_read) {
    unsigned char byte;
    ssize_t n;
    do {
        n = read(ready_read, &byte, 1);
    } while (n < 0 && errno == EINTR);
    return n == 1;
}

static int usage(void) {
    fputs("usage:\n"
          "  nimbus-sandbox-helper --check\n"
          "  nimbus-sandbox-helper --socket <path> [--alias <ip>]... "
          "--listen <ip>:<port>:<index>... --dns <ip> -- <argv...>\n",
          stderr);
    return EXIT_USAGE;
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "--check") == 0) {
        puts("OK");
        return 0;
    }

    options_t options;
    memset(&options, 0, sizeof(options));
    if (argc < 2 || !parse_args(argc, argv, &options)) {
        return usage();
    }
    if (!reserve_low_fds()) {
        fprintf(stderr, "nimbus-sandbox-helper: /dev/null: %s\n", strerror(errno));
        return EXIT_BIND;
    }

    int rc = apply_aliases(&options);
    if (rc != 0) {
        return rc;
    }
    rc = bind_listeners(&options);
    if (rc != 0) {
        return rc;
    }
    int dns_fd = bind_dns(&options);
    if (dns_fd < 0) {
        return EXIT_BIND;
    }

    int ready[2];
    if (pipe2(ready, O_CLOEXEC) != 0) {
        fprintf(stderr, "nimbus-sandbox-helper: forwarder pipe: %s\n", strerror(errno));
        return EXIT_LOCKDOWN;
    }

    pid_t launcher = getpid();
    pid_t forwarder = fork();
    if (forwarder < 0) {
        fprintf(stderr, "nimbus-sandbox-helper: fork: %s\n", strerror(errno));
        return EXIT_BIND;
    }
    if (forwarder == 0) {
        const unsigned char ready_byte = 'k';
        close(ready[0]);
        if (lock_down(launcher) && write_all(ready[1], &ready_byte, 1)) {
            close(ready[1]);
            forward(&options, dns_fd);
        }
        _exit(1);
    }

    /* A forwarder that dies later only stops relaying. Before this point, nothing may start. */
    close(ready[1]);
    if (!forwarder_locked_down(ready[0])) {
        fputs("nimbus-sandbox-helper: the forwarder could not lock itself down\n", stderr);
        return EXIT_LOCKDOWN;
    }
    close(ready[0]);

    /* The launcher keeps its capabilities: the inner bwrap needs CAP_SETFCAP, and drops them all. */
    if (!set_signal(SIGCHLD, SIG_DFL)) {
        fprintf(stderr, "nimbus-sandbox-helper: sigaction: %s\n", strerror(errno));
        return EXIT_EXEC;
    }
    execv(options.child_argv[0], options.child_argv);
    fprintf(stderr, "nimbus-sandbox-helper: exec %s: %s\n", options.child_argv[0], strerror(errno));
    return EXIT_EXEC;
}

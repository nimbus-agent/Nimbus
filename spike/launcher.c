/* THROWAWAY. launcher <unix-sock> <ip> <port> -- payload...
 * Bind while holding CAP_NET_BIND_SERVICE, drop every capability, fork the forwarder, exec payload. */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <linux/capability.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>

static void relay(int a, int b) {
  struct pollfd p[2] = {{a, POLLIN, 0}, {b, POLLIN, 0}};
  char buf[8192];
  for (;;) {
    if (poll(p, 2, -1) < 0) return;
    for (int i = 0; i < 2; i++) {
      if (p[i].revents) {
        ssize_t n = read(p[i].fd, buf, sizeof buf);
        if (n <= 0) return;
        if (write(p[1 - i].fd, buf, (size_t)n) != n) return;
      }
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 6) return 2;
  const char *sock = argv[1];
  int l = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(l, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)atoi(argv[3]));
  inet_pton(AF_INET, argv[2], &a.sin_addr);
  if (bind(l, (struct sockaddr *)&a, sizeof a) != 0) { perror("launcher bind"); return 3; }
  if (listen(l, 16) != 0) { perror("listen"); return 3; }
  fprintf(stderr, "launcher: bound %s:%s\n", argv[2], argv[3]);

  prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0);
  for (int c = 0; c <= CAP_LAST_CAP; c++) prctl(PR_CAPBSET_DROP, c, 0, 0, 0);
  prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
  struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct d[2];
  memset(d, 0, sizeof d);
  if (syscall(SYS_capset, &h, d) != 0) { perror("capset"); return 4; }

  signal(SIGCHLD, SIG_IGN);
  if (fork() == 0) {
    for (;;) {
      int c = accept(l, NULL, NULL);
      if (c < 0) continue;
      if (fork() == 0) {
        int u = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un s = {0};
        s.sun_family = AF_UNIX;
        strncpy(s.sun_path, sock, sizeof s.sun_path - 1);
        if (connect(u, (struct sockaddr *)&s, sizeof s) == 0) relay(c, u);
        _exit(0);
      }
      close(c);
    }
  }
  close(l);
  execv(argv[5], &argv[5]);
  perror("execv");
  return 127;
}

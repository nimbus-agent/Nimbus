/* Prints the libproc struct sizes and field offsets 6b-2's Bun FFI reader needs (macOS SDK). */
#include <libproc.h>
#include <sys/proc_info.h>
#include <stddef.h>
#include <stdio.h>

int main(void) {
    printf("{\n");
    printf("  \"sizeof_proc_fdinfo\": %zu,\n", sizeof(struct proc_fdinfo));
    printf("  \"off_proc_fdinfo_fd\": %zu,\n", offsetof(struct proc_fdinfo, proc_fd));
    printf("  \"off_proc_fdinfo_type\": %zu,\n", offsetof(struct proc_fdinfo, proc_fdtype));
    printf("  \"PROC_PIDLISTFD_SIZE\": %d,\n", (int)PROC_PIDLISTFD_SIZE);
    printf("  \"PROX_FDTYPE_SOCKET\": %d,\n", PROX_FDTYPE_SOCKET);
    printf("  \"PROC_PIDLISTFDS\": %d,\n", PROC_PIDLISTFDS);
    printf("  \"PROC_PIDFDSOCKETINFO\": %d,\n", PROC_PIDFDSOCKETINFO);
    printf("  \"PROC_PIDTBSDINFO\": %d,\n", PROC_PIDTBSDINFO);
    printf("  \"sizeof_proc_bsdinfo\": %zu,\n", sizeof(struct proc_bsdinfo));
    printf("  \"off_pbi_ppid\": %zu,\n", offsetof(struct proc_bsdinfo, pbi_ppid));
    printf("  \"sizeof_socket_fdinfo\": %zu,\n", sizeof(struct socket_fdinfo));
    printf("  \"off_psi\": %zu,\n", offsetof(struct socket_fdinfo, psi));
    printf("  \"off_soi_kind\": %zu,\n", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_kind));
    printf("  \"SOCKINFO_TCP\": %d,\n", SOCKINFO_TCP);
    size_t ini = offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_ini);
    printf("  \"off_ini\": %zu,\n", ini);
    printf("  \"off_insi_fport\": %zu,\n", ini + offsetof(struct in_sockinfo, insi_fport));
    printf("  \"off_insi_lport\": %zu,\n", ini + offsetof(struct in_sockinfo, insi_lport));
    printf("  \"off_insi_vflag\": %zu,\n", ini + offsetof(struct in_sockinfo, insi_vflag));
    printf("  \"off_insi_faddr\": %zu,\n", ini + offsetof(struct in_sockinfo, insi_faddr));
    printf("  \"off_faddr_v4\": %zu,\n", ini + offsetof(struct in_sockinfo, insi_faddr) + offsetof(struct in4in6_addr, i46a_addr4));
    printf("  \"INI_IPV4\": %d,\n", INI_IPV4);
    printf("  \"INI_IPV6\": %d,\n", INI_IPV6);
    printf("  \"off_tcpsi_state\": %zu\n", offsetof(struct socket_fdinfo, psi) + offsetof(struct socket_info, soi_proto) + offsetof(struct tcp_sockinfo, tcpsi_state));
    printf("}\n");
    return 0;
}

/**
 * The shape every per-OS connection source hands the network-observation poller (Windows: the TCP
 * connection table attributed by AppContainer SID; macOS: the process tree's sockets).
 *
 * Observation only: nothing here decides what a sandboxed child may reach.
 */

/** One TCP connection owned by a process the source attributes to the observed extension. */
export type ObservedConnection = {
  pid: number;
  localPort: number;
  /** An IPv4 dotted quad or a compressed lowercase IPv6 literal (RFC 5952), never a host name. */
  remoteIp: string;
  remotePort: number;
};

export interface ConnectionSource {
  /**
   * The attributed connections open right now (listeners and rows with no remote address are
   * left out). Throws when the OS table itself cannot be read, so a caller can count failures.
   */
  poll(): ObservedConnection[];
  /** Releases every OS resource the source holds. Idempotent. */
  close(): void;
}

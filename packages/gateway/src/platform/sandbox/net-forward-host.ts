/**
 * The wrapper's end of the Linux network forwarder, and the point where the policy is enforced.
 *
 * A forwarder inside the sandbox relays each connection over a unix socket to this code, outside
 * the sandbox. Everything on that socket is hostile: the only thing it may choose is WHICH entry to
 * check. The name, the port and the trust all come from the plan, and a connection goes only to an
 * address `allowedAddresses` kept for that entry.
 *
 * Wire format, one per unix connection: a 3-byte header, then the stream. Byte 0 is `T` or `D`,
 * bytes 1 and 2 the big-endian entry index (0 for `D`). `T` relays until either side closes. `D`
 * reads a 2-byte big-endian length and a datagram, writes a 2-byte length and the reply, and closes.
 *
 * Log lines hold a sanitised name, a port and a reason, never relayed bytes and never an address.
 */

import { lookup } from "node:dns/promises";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { parseNetworkEntry } from "@nimbus-dev/registry-format";
import { registerListener } from "../../locality/listener-registry.ts";
import {
  allowedAddresses,
  classifyAddress,
  type EntryTrust,
  isIpv4Literal,
} from "./net-address-rules.ts";
import { answerDnsQuery, type DnsNames } from "./net-dns-stub.ts";
import { wildcardHostMatches } from "./net-wildcard-hosts.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export interface ForwardEntry {
  /** The name or literal to check, or null for a pool slot, whose name the stub resolver assigns. */
  host: string | null;
  port: number;
  trust: EntryTrust;
  /** The address the launcher listens on: an assigned `127.0.0.x`, or the entry's own literal. */
  loopbackIp: string;
}

export type ForwardConnectionStats = {
  startedAtMs: number;
  durationMs: number;
  bytesToHost: number;
  bytesFromHost: number;
};

export type NetSocketHandlers = {
  data(chunk: Uint8Array): void;
  drain(): void;
  /** The peer sent its FIN. */
  end(): void;
  close(): void;
};

/** The direction-neutral half of a socket that the relay writes to and paces. */
type ByteSocket = {
  /** Bytes accepted now: less than given means wait for `drain`, negative means the socket is gone. */
  write(data: Uint8Array): number;
  /** Sends FIN and keeps reading. */
  shutdownWrite(): void;
  close(): void;
  pause(): void;
  resume(): void;
};

/** What `connect` hands back. Events that fire before `setHandlers` are held and replayed. */
export interface NetSocketLike extends ByteSocket {
  setHandlers(handlers: NetSocketHandlers): void;
}

export type ForwardHostOptions = {
  socketPath: string;
  entries: readonly ForwardEntry[];
  /** Read live on every check. */
  wildcards?: readonly string[];
  resolve: (host: string) => Promise<string[]>;
  connect: (ip: string, port: number) => Promise<NetSocketLike>;
  log: (line: string) => void;
  now?: () => number;
  /** The project 6 seam. A pool slot's entry arrives with `host` set to the name the slot holds. */
  onConnectionClosed?: (e: ForwardEntry, stats: ForwardConnectionStats) => void;
  /** The project 6 seam: a name the stub refused, or a declared name with no address it may reach. */
  onRefusedName?: (name: string) => void;
  /** How long a connection may take to send a complete header (`D`: its complete datagram). */
  headerTimeoutMs?: number;
};

/** `127.0.0.2` to `127.0.0.254`, less `127.0.0.53`. */
const MAX_HOSTS = 252;
const FIRST_ASSIGNED_OCTET = 2;
const LAST_ASSIGNED_OCTET = 254;
export const RESOLVER_ADDRESS = "127.0.0.53";
const POOL_SIZE = 48;
const WILDCARD_PORT = 443;

const MAX_CONNECTIONS = 256;
const HIGH_WATER_BYTES = 1024 * 1024;
const DEFAULT_HEADER_TIMEOUT_MS = 5000;
const HEADER_LENGTH = 3;
const DNS_LENGTH_PREFIX = 2;
const KIND_TCP = 0x54; // "T"
const KIND_DNS = 0x44; // "D"
const RCODE_MASK = 0x0f;
const RCODE_SERVFAIL = 2;

const REFUSAL_LOG_WINDOW_MS = 60_000;
const MAX_TRACKED_REFUSED_NAMES = 1024;
const REFUSAL_LINES_PER_MINUTE = 60;
const MAX_LOGGED_NAME_LENGTH = 255;

/** Case-insensitive, with one trailing dot dropped. */
function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

function trustFor(raw: string, policy: SandboxPolicy): EntryTrust {
  if (policy.ownerConfiguredNetwork?.includes(raw) === true) return "owner";
  return policy.firstPartyPolicy === true ? "first-party" : "package";
}

type PlannedEntry = { host: string; port: number; trust: EntryTrust };

function parsePlannedEntry(raw: string, policy: SandboxPolicy): PlannedEntry {
  const { host: rawHost, port } = parseNetworkEntry(raw);
  const host = normalizeHost(rawHost);
  if (host === "" || host.includes(":") || host.includes("[")) {
    throw new Error(`network entry has no usable host: ${raw}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`network entry has no usable port: ${raw}`);
  }
  if (host === RESOLVER_ADDRESS) {
    throw new Error(`network entry names the sandbox's resolver address: ${raw}`);
  }
  if (isIpv4Literal(host) && classifyAddress(host) === "refused") {
    throw new Error(`network entry names an address no entry may reach: ${raw}`);
  }
  return { host, port, trust: trustFor(raw, policy) };
}

/** One entry per distinct host and port. A repeat the owner typed makes the entry the owner's. */
function distinctEntries(policy: SandboxPolicy): PlannedEntry[] {
  const byTarget = new Map<string, PlannedEntry>();
  for (const raw of policy.permissions.network) {
    const planned = parsePlannedEntry(raw, policy);
    const key = `${planned.host}|${String(planned.port)}`;
    const seen = byTarget.get(key);
    if (seen === undefined) byTarget.set(key, planned);
    else if (planned.trust === "owner") seen.trust = "owner";
  }
  return [...byTarget.values()];
}

/** Hands out the assigned range in order, skipping the resolver and any address a literal holds. */
function addressAllocator(held: ReadonlySet<string>): () => string {
  let octet = FIRST_ASSIGNED_OCTET;
  return () => {
    while (octet <= LAST_ASSIGNED_OCTET) {
      const ip = `127.0.0.${String(octet)}`;
      octet += 1;
      if (ip !== RESOLVER_ADDRESS && !held.has(ip)) return ip;
    }
    throw new Error("the sandbox's loopback range is exhausted");
  };
}

/**
 * The listeners a policy needs. Pure, so every OS can test it. Exact entries come first, one
 * `127.0.0.x` per distinct host (two ports on a host share it), and an IP literal keeps its own
 * address. A policy with wildcards then gets its pool of `127.0.0.x:443` slots.
 */
export function planForwardEntries(policy: SandboxPolicy): ForwardEntry[] {
  const hasWildcards = (policy.firstPartyWildcardHosts?.length ?? 0) > 0;
  if (hasWildcards && policy.firstPartyPolicy !== true) {
    throw new Error("a policy with wildcard hosts must be a first-party policy");
  }
  const planned = distinctEntries(policy);
  const hosts = new Set(planned.map((p) => p.host));
  if (hosts.size > MAX_HOSTS) {
    throw new Error(`a policy may declare at most ${String(MAX_HOSTS)} hosts`);
  }
  const nextAddress = addressAllocator(new Set([...hosts].filter(isIpv4Literal)));
  const ipByHost = new Map<string, string>();
  for (const host of hosts) ipByHost.set(host, isIpv4Literal(host) ? host : nextAddress());
  const entries: ForwardEntry[] = planned.map((p) => {
    const loopbackIp = ipByHost.get(p.host);
    if (loopbackIp === undefined) throw new Error(`no address was assigned to ${p.host}`);
    return { ...p, loopbackIp };
  });
  if (!hasWildcards) return entries;
  const slots = Math.min(POOL_SIZE, MAX_HOSTS - hosts.size);
  for (let i = 0; i < slots; i += 1) {
    entries.push({
      host: null,
      port: WILDCARD_PORT,
      trust: "first-party",
      loopbackIp: nextAddress(),
    });
  }
  return entries;
}

function sanitiseName(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9._-]/g, "?").slice(0, MAX_LOGGED_NAME_LENGTH);
}

/**
 * The shared per-minute line budget. Returns whether a line at `at` may be logged; the first
 * refusal over the budget says so once through `log`, and the budget resets each window.
 */
function createRefusalBudget(
  log: (line: string) => void,
  linesPerMinute: number,
): (at: number) => boolean {
  let budgetStartedAt = Number.NEGATIVE_INFINITY;
  let linesInBudget = 0;
  let toldSuppressed = false;
  return (at) => {
    if (at - budgetStartedAt >= REFUSAL_LOG_WINDOW_MS) {
      budgetStartedAt = at;
      linesInBudget = 0;
      toldSuppressed = false;
    }
    if (linesInBudget < linesPerMinute) {
      linesInBudget += 1;
      return true;
    }
    if (!toldSuppressed) {
      toldSuppressed = true;
      log("net-forward: further refusals suppressed this minute");
    }
    return false;
  };
}

/** Drops the oldest entry (a Map iterates in insertion order). */
function evictOldest(map: Map<string, number>): void {
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * At most one line per name per minute. The map is bounded, oldest first, because a hostile child
 * can send unlimited distinct names. A name evicted that way may log again inside its minute.
 *
 * All names share a budget per minute, for the same reason. The first line over it says so once,
 * and a name it holds back is not recorded, so that name can log later. `linesPerMinute` is an
 * override for tests, which reach the map's bound only with the budget out of the way.
 */
export function createRefusalLog(
  log: (line: string) => void,
  now: () => number,
  linesPerMinute = REFUSAL_LINES_PER_MINUTE,
): (name: string, port: number | null, reason: string) => void {
  const lastLoggedAt = new Map<string, number>();
  const withinBudget = createRefusalBudget(log, linesPerMinute);
  return (name, port, reason) => {
    const at = now();
    const last = lastLoggedAt.get(name);
    if (last !== undefined && at - last < REFUSAL_LOG_WINDOW_MS) return;
    if (!withinBudget(at)) return;
    lastLoggedAt.delete(name);
    lastLoggedAt.set(name, at);
    if (lastLoggedAt.size > MAX_TRACKED_REFUSED_NAMES) evictOldest(lastLoggedAt);
    const target = port === null ? name : `${name}:${String(port)}`;
    log(`net-forward: ${target}: ${reason}`);
  };
}

type NameTable = DnsNames & {
  /** The name a pool slot holds, or null when it holds none or the wildcards no longer cover it. */
  nameOnSlot(index: number): string | null;
};

function createNameTable(
  entries: readonly ForwardEntry[],
  wildcards: readonly string[],
): NameTable {
  const exact = new Map<string, string>();
  const freeSlots: number[] = [];
  entries.forEach((entry, index) => {
    if (entry.host === null) freeSlots.push(index);
    else exact.set(normalizeHost(entry.host), entry.loopbackIp);
  });
  const slotByName = new Map<string, number>();
  const nameBySlot = new Map<number, string>();
  const matchesWildcard = (name: string): boolean =>
    wildcards.some((pattern) => wildcardHostMatches(pattern, name));
  const addressOfSlot = (slot: number): string | null => entries[slot]?.loopbackIp ?? null;

  return {
    isDeclared: (name) => exact.has(name) || matchesWildcard(name),
    hasRoom: (name) => exact.has(name) || slotByName.has(name) || freeSlots.length > 0,
    addressFor: (name) => {
      const exactAddress = exact.get(name);
      if (exactAddress !== undefined) return exactAddress;
      const held = slotByName.get(name);
      if (held !== undefined) return addressOfSlot(held);
      const slot = freeSlots.shift();
      if (slot === undefined) return null;
      slotByName.set(name, slot);
      nameBySlot.set(slot, name);
      return addressOfSlot(slot);
    },
    nameOnSlot: (index) => {
      const name = nameBySlot.get(index);
      return name !== undefined && matchesWildcard(name) ? name : null;
    },
  };
}

/** One write direction. Bun's sockets do not buffer: what `write` does not accept stays here. */
class Outbox {
  private readonly queue: Uint8Array[] = [];
  private broken = false;
  bytes = 0;

  constructor(
    private readonly to: ByteSocket,
    private readonly onSent: (n: number) => void,
    private readonly onBroken: () => void,
  ) {}

  private write(chunk: Uint8Array): number {
    const n = this.to.write(chunk);
    if (n < 0) {
      this.clear();
      this.broken = true;
      this.onBroken();
      return 0;
    }
    this.onSent(n);
    return n;
  }

  send(chunk: Uint8Array): void {
    const sent = this.queue.length === 0 ? this.write(chunk) : 0;
    if (this.broken || sent >= chunk.length) return;
    this.queue.push(new Uint8Array(chunk.subarray(sent)));
    this.bytes += chunk.length - sent;
  }

  flush(): void {
    let head = this.queue[0];
    while (head !== undefined) {
      const n = this.write(head);
      if (this.broken) return;
      this.bytes -= n;
      if (n < head.length) {
        this.queue[0] = head.subarray(n);
        return;
      }
      this.queue.shift();
      head = this.queue[0];
    }
  }

  clear(): void {
    this.queue.length = 0;
    this.bytes = 0;
  }
}

/** Bytes travelling one way through a relay, and how far that way has shut down. */
type Direction = {
  from: ByteSocket;
  to: ByteSocket;
  out: Outbox;
  fromEof: boolean;
  finSent: boolean;
  paused: boolean;
};

type Conn = {
  side: ByteSocket;
  startedAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Bytes read but not yet acted on: the header, a `D` frame, or what arrives during a dial. */
  held: Uint8Array[];
  heldBytes: number;
  dnsLength: number | null;
  onData: (chunk: Uint8Array) => void;
  onDrain: () => void;
  onEnd: () => void;
  onClose: () => void;
  sawEof: boolean;
  /** A dial in flight holds its slot even after the child hangs up, since it holds a descriptor. */
  dialing: boolean;
  closing: boolean;
  remote: NetSocketLike | null;
  reportClosed: (() => void) | null;
};

function hold(conn: Conn, chunk: Uint8Array): void {
  conn.held.push(new Uint8Array(chunk));
  conn.heldBytes += chunk.length;
}

/** Everything held so far as one buffer, kept as one so a 1-byte writer costs no repeated copies. */
function mergeHeld(conn: Conn): Uint8Array {
  if (conn.held.length === 1) return conn.held[0] ?? new Uint8Array(0);
  const merged = new Uint8Array(conn.heldBytes);
  let at = 0;
  for (const chunk of conn.held) {
    merged.set(chunk, at);
    at += chunk.length;
  }
  conn.held = [merged];
  return merged;
}

function replaceHeld(conn: Conn, bytes: Uint8Array): void {
  conn.held = bytes.length === 0 ? [] : [bytes];
  conn.heldBytes = bytes.length;
}

/** One side failing to close must not stop the other side closing or the report being made. */
function attemptClose(socket: ByteSocket | null): void {
  try {
    socket?.close();
  } catch {
    // Nothing more can be done for this socket.
  }
}

function ignore(): void {
  // A phase with nothing to do for this event.
}

/** Exported for tests only, which drive a connection with no socket. Production uses `startForwardHost`. */
export class ForwardHost {
  private readonly conns = new Set<Conn>();
  private readonly names: NameTable;
  private readonly now: () => number;
  private readonly refusalLog: (name: string, port: number | null, reason: string) => void;
  private readonly headerTimeoutMs: number;

  constructor(private readonly opts: ForwardHostOptions) {
    this.names = createNameTable(opts.entries, opts.wildcards ?? []);
    this.now = opts.now ?? Date.now;
    this.refusalLog = createRefusalLog((line) => {
      try {
        opts.log(line);
      } catch {
        // A log sink never takes down the host.
      }
    }, this.now);
    this.headerTimeoutMs = opts.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
  }

  /** The new connection's record, or null when the cap is reached and it must be closed. */
  accept(side: ByteSocket): Conn | null {
    if (this.conns.size >= MAX_CONNECTIONS) return null;
    const conn: Conn = {
      side,
      startedAtMs: this.now(),
      timer: null,
      held: [],
      heldBytes: 0,
      dnsLength: null,
      onData: (chunk) => this.readHeader(conn, chunk),
      onDrain: ignore,
      onEnd: () => this.closeConn(conn),
      onClose: () => this.closeConn(conn),
      sawEof: false,
      dialing: false,
      closing: false,
      remote: null,
      reportClosed: null,
    };
    conn.timer = setTimeout(() => this.closeConn(conn), this.headerTimeoutMs);
    conn.timer.unref();
    this.conns.add(conn);
    return conn;
  }

  /** Runs one socket event, so a bug on a hostile path closes that connection and nothing else. */
  guarded(conn: Conn, event: () => void): void {
    if (conn.closing) return;
    try {
      event();
    } catch {
      this.closeConn(conn);
    }
  }

  closeConn(conn: Conn): void {
    if (conn.closing) {
      this.release(conn);
      return;
    }
    conn.closing = true;
    this.clearBound(conn);
    conn.held = [];
    attemptClose(conn.remote);
    attemptClose(conn.side);
    this.release(conn);
    conn.reportClosed?.();
  }

  private release(conn: Conn): void {
    if (conn.closing && !conn.dialing) this.conns.delete(conn);
  }

  private clearBound(conn: Conn): void {
    if (conn.timer !== null) clearTimeout(conn.timer);
    conn.timer = null;
  }

  closeAll(): void {
    for (const conn of [...this.conns]) this.closeConn(conn);
  }

  private readHeader(conn: Conn, chunk: Uint8Array): void {
    const kind = conn.heldBytes === 0 ? chunk[0] : conn.held[0]?.[0];
    if (kind !== KIND_TCP && kind !== KIND_DNS) {
      this.closeConn(conn);
      return;
    }
    hold(conn, chunk);
    if (conn.heldBytes < HEADER_LENGTH) return;
    const bytes = mergeHeld(conn);
    const index = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
    replaceHeld(conn, bytes.subarray(HEADER_LENGTH));
    if (kind === KIND_TCP) this.startTcp(conn, index);
    else this.startDns(conn, index);
  }

  private startDns(conn: Conn, index: number): void {
    if (index !== 0) {
      this.closeConn(conn);
      return;
    }
    conn.onData = (chunk) => {
      hold(conn, chunk);
      this.readDnsFrame(conn);
    };
    this.readDnsFrame(conn);
  }

  /** Acts once the whole frame is in. A frame with anything after its datagram is refused. */
  private readDnsFrame(conn: Conn): void {
    if (conn.dnsLength === null) {
      if (conn.heldBytes < DNS_LENGTH_PREFIX) return;
      const prefix = mergeHeld(conn);
      conn.dnsLength = ((prefix[0] ?? 0) << 8) | (prefix[1] ?? 0);
    }
    const total = DNS_LENGTH_PREFIX + conn.dnsLength;
    if (conn.dnsLength === 0 || conn.heldBytes > total) {
      this.closeConn(conn);
      return;
    }
    if (conn.heldBytes === total) this.answerDns(conn, mergeHeld(conn).subarray(DNS_LENGTH_PREFIX));
  }

  private answerDns(conn: Conn, datagram: Uint8Array): void {
    conn.onData = ignore;
    conn.onEnd = ignore;
    const { reply, refusedName } = answerDnsQuery(datagram, this.names);
    if (reply === null) {
      this.closeConn(conn);
      return;
    }
    if (refusedName !== null) this.noteRefusedDnsName(refusedName, reply);
    const frame = new Uint8Array(DNS_LENGTH_PREFIX + reply.length);
    new DataView(frame.buffer).setUint16(0, reply.length);
    frame.set(reply, DNS_LENGTH_PREFIX);
    const out = new Outbox(conn.side, ignore, () => this.closeConn(conn));
    const closeWhenSent = (): void => {
      if (out.bytes === 0) this.closeConn(conn);
    };
    conn.onDrain = () => {
      out.flush();
      closeWhenSent();
    };
    out.send(frame);
    closeWhenSent();
  }

  private noteRefusedDnsName(rawName: string, reply: Uint8Array): void {
    const poolFull = ((reply[3] ?? 0) & RCODE_MASK) === RCODE_SERVFAIL;
    this.noteRefusedName(rawName, null, poolFull ? "wildcard pool full" : "undeclared name");
  }

  private noteRefusedName(rawName: string, port: number | null, reason: string): void {
    const name = sanitiseName(rawName);
    this.refusalLog(name, port, reason);
    try {
      this.opts.onRefusedName?.(name);
    } catch {
      // The seam never takes down the host.
    }
  }

  /** The name a connection on this entry resolves, from the plan and never from the forwarder. */
  private nameForEntry(index: number, entry: ForwardEntry): string | null {
    return entry.host ?? this.names.nameOnSlot(index);
  }

  private startTcp(conn: Conn, index: number): void {
    const entry = this.opts.entries[index];
    const name = entry === undefined ? null : this.nameForEntry(index, entry);
    if (entry === undefined || name === null) {
      this.closeConn(conn);
      return;
    }
    this.clearBound(conn);
    conn.side.pause();
    conn.onData = (chunk) => {
      hold(conn, chunk);
      if (conn.heldBytes > HIGH_WATER_BYTES) this.closeConn(conn);
    };
    conn.onEnd = () => {
      conn.sawEof = true;
    };
    conn.dialing = true;
    void this.dialAndRelay(conn, entry, name)
      .catch(() => this.closeConn(conn))
      .finally(() => {
        conn.dialing = false;
        if (conn.reportClosed === null) this.closeConn(conn);
        else this.release(conn);
      });
  }

  private async dialAndRelay(conn: Conn, entry: ForwardEntry, name: string): Promise<void> {
    const kept = await this.resolveAllowed(conn, entry, name);
    if (kept.length === 0 || conn.closing) return;
    const remote = await this.connectFirst(conn, kept, entry.port);
    if (remote === null) {
      if (!conn.closing) this.refusalLog(sanitiseName(name), entry.port, "connect failed");
      return;
    }
    if (conn.closing) {
      remote.close();
      return;
    }
    this.startRelay(conn, remote, entry, name);
  }

  /** Resolves once and filters once: only what this returns is ever connected to. */
  private async resolveAllowed(
    conn: Conn,
    entry: ForwardEntry,
    name: string,
  ): Promise<readonly string[]> {
    let answers: string[];
    try {
      answers = await this.opts.resolve(name);
    } catch {
      if (!conn.closing) this.refusalLog(sanitiseName(name), entry.port, "lookup failed");
      return [];
    }
    const kept = allowedAddresses({ host: name, trust: entry.trust }, answers);
    if (kept.length === 0 && !conn.closing) {
      this.noteRefusedName(name, entry.port, "refused address");
    }
    return kept;
  }

  private async connectFirst(
    conn: Conn,
    kept: readonly string[],
    port: number,
  ): Promise<NetSocketLike | null> {
    for (const ip of kept) {
      if (conn.closing) return null;
      try {
        return await this.opts.connect(ip, port);
      } catch {
        // The next kept address, if any.
      }
    }
    return null;
  }

  private startRelay(conn: Conn, remote: NetSocketLike, entry: ForwardEntry, name: string): void {
    let bytesToHost = 0;
    let bytesFromHost = 0;
    const broken = (): void => this.closeConn(conn);
    const direction = (from: ByteSocket, to: ByteSocket, sent: (n: number) => void): Direction => ({
      from,
      to,
      out: new Outbox(to, sent, broken),
      fromEof: false,
      finSent: false,
      paused: false,
    });
    const toHost = direction(conn.side, remote, (n) => {
      bytesToHost += n;
    });
    const fromHost = direction(remote, conn.side, (n) => {
      bytesFromHost += n;
    });
    const sendFinIfDue = (d: Direction): void => {
      if (d.fromEof && !d.finSent && d.out.bytes === 0) {
        d.finSent = true;
        d.to.shutdownWrite();
      }
      if (toHost.finSent && fromHost.finSent) this.closeConn(conn);
    };
    const eof = (d: Direction): void => {
      d.fromEof = true;
      sendFinIfDue(d);
    };
    const drained = (d: Direction): void => {
      d.out.flush();
      resumeIfRoom(d);
      sendFinIfDue(d);
    };

    conn.remote = remote;
    conn.reportClosed = () => {
      this.reportClosed(conn, entry, name, bytesToHost, bytesFromHost);
    };
    conn.onData = (chunk) => pump(toHost, chunk);
    conn.onDrain = () => drained(fromHost);
    conn.onEnd = () => eof(toHost);
    // Once this side has sent its FIN, Bun reports the child's as `close` alone. Either way, what
    // the child already sent still reaches the host, and nothing more can reach the child.
    conn.onClose = () => {
      fromHost.out.clear();
      fromHost.finSent = true;
      eof(toHost);
    };
    const leftover = mergeHeld(conn);
    const childEnded = conn.sawEof;
    replaceHeld(conn, new Uint8Array(0));
    remote.setHandlers({
      data: (chunk) => this.guarded(conn, () => pump(fromHost, chunk)),
      drain: () => this.guarded(conn, () => drained(toHost)),
      end: () => this.guarded(conn, () => eof(fromHost)),
      close: () =>
        this.guarded(conn, () => {
          // The host is gone: nothing more can reach it, but what it sent still reaches the child.
          toHost.out.clear();
          toHost.finSent = true;
          eof(fromHost);
        }),
    });
    if (conn.closing) return;
    if (leftover.length > 0) pump(toHost, leftover);
    if (childEnded) eof(toHost);
    if (!conn.closing) conn.side.resume();
  }

  private reportClosed(
    conn: Conn,
    entry: ForwardEntry,
    name: string,
    bytesToHost: number,
    bytesFromHost: number,
  ): void {
    try {
      this.opts.onConnectionClosed?.(
        { ...entry, host: name },
        {
          startedAtMs: conn.startedAtMs,
          durationMs: this.now() - conn.startedAtMs,
          bytesToHost,
          bytesFromHost,
        },
      );
    } catch {
      // The seam never takes down the host.
    }
  }
}

/** Queues a chunk toward `d.to`, and stops reading `d.from` once too much is waiting. */
function pump(d: Direction, chunk: Uint8Array): void {
  if (d.finSent) return; // the far side is gone, so there is nowhere for this to go
  d.out.send(chunk);
  if (d.out.bytes > HIGH_WATER_BYTES && !d.paused) {
    d.paused = true;
    d.from.pause();
  }
}

function resumeIfRoom(d: Direction): void {
  if (d.paused && d.out.bytes <= HIGH_WATER_BYTES) {
    d.paused = false;
    d.from.resume();
  }
}

/** Only the wrapper and the outer `bwrap` may reach the socket, so its directory must be private. */
function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) {
    throw new Error(`the forwarder socket's directory is not private: ${dir}`);
  }
}

/**
 * Starts the host. The bind is synchronous, so the socket exists before the helper spawns, and a
 * failure to bind throws here, which refuses the spawn.
 */
export function startForwardHost(opts: ForwardHostOptions): { close(): void } {
  ensurePrivateDirectory(dirname(opts.socketPath));
  const host = new ForwardHost(opts);
  const listener = Bun.listen<Conn | null>({
    unix: opts.socketPath,
    allowHalfOpen: true,
    data: null,
    socket: {
      open(socket) {
        const conn = host.accept({
          write: (data) => socket.write(data),
          // With no argument this is shutdown(SHUT_WR). `shutdown(true)` is SHUT_RD on Bun 1.4,
          // the reverse of its doc comment, and `end()` closes both ways.
          shutdownWrite: () => socket.shutdown(),
          close: () => socket.end(),
          pause: () => socket.pause(),
          resume: () => socket.resume(),
        });
        socket.data = conn;
        if (conn === null) socket.end();
      },
      data(socket, chunk) {
        const conn = socket.data;
        if (conn !== null) host.guarded(conn, () => conn.onData(chunk));
      },
      drain(socket) {
        const conn = socket.data;
        if (conn !== null) host.guarded(conn, () => conn.onDrain());
      },
      end(socket) {
        const conn = socket.data;
        if (conn !== null) host.guarded(conn, () => conn.onEnd());
      },
      close(socket) {
        const conn = socket.data;
        if (conn !== null) host.guarded(conn, () => conn.onClose());
      },
      error(socket) {
        if (socket.data !== null) host.closeConn(socket.data);
      },
    },
  });
  // Registered as D31 requires. The wrapper is its own process, so no locality panel reads this
  // copy of the registry.
  const unregisterListener = registerListener(() => ({
    name: "sandbox_forward",
    address: opts.socketPath,
    loopback: true,
  }));
  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      unregisterListener();
      host.closeAll();
      listener.stop(true);
      rmSync(opts.socketPath, { force: true });
    },
  };
}

/** The production `resolve`: every address the host's own resolver returns. */
export async function resolveOnHost(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true });
  return answers.map((answer) => answer.address);
}

/** The production `connect`. `ip` is always an address `allowedAddresses` kept, never a name. */
export async function connectTcp(ip: string, port: number): Promise<NetSocketLike> {
  let handlers: NetSocketHandlers | null = null;
  const missed: ((h: NetSocketHandlers) => void)[] = [];
  const fire = (event: (h: NetSocketHandlers) => void): void => {
    if (handlers === null) missed.push(event);
    else event(handlers);
  };
  const socket = await Bun.connect({
    hostname: ip,
    port,
    allowHalfOpen: true,
    socket: {
      data(_socket, chunk) {
        const copy = new Uint8Array(chunk);
        fire((h) => h.data(copy));
      },
      drain() {
        fire((h) => h.drain());
      },
      end() {
        fire((h) => h.end());
      },
      close() {
        fire((h) => h.close());
      },
      error() {
        // `close` follows.
      },
    },
  });
  return {
    write: (data) => socket.write(data),
    shutdownWrite: () => socket.shutdown(),
    close: () => socket.end(),
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    setHandlers(next) {
      handlers = next;
      for (const event of missed.splice(0)) event(next);
    },
  };
}

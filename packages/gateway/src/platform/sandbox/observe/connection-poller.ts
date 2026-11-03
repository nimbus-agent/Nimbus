/**
 * The Windows and macOS half of network observation (project 6, PR 6b-2): polls a connection
 * source that attributes TCP connections to the sandboxed child, and turns each NEW connection into
 * an observation, `used <declared host>:<port>` when its address and port match a declared entry,
 * else `unmatched <ip>:<port>`. Neither OS limits hosts (I50 bound 5), so this sees what the child
 * reached; it decides nothing, and no enforcement path reads it.
 *
 * Matching is by forward resolution of the DECLARED names only: each name the policy's
 * `permissions.network` lists is looked up at start and every {@link RESOLVE_REFRESH_MS}, and every
 * answer is kept for the child's lifetime (at most {@link MAX_ANSWERS_PER_HOST} per host), so a CDN
 * that rotates addresses still matches. Those lookups are the only outbound request observation
 * makes. They are not in the egress ledger (I29 and I50 bound 6, stated bounds), a remote address is
 * never looked up, and there is no reverse DNS: an address that matches nothing stays an address.
 *
 * Connection identity is `(pid, localPort, remoteIp, remotePort)`: counted when it appears in a poll
 * and was not in the previous one, so only the previous poll's set is kept, and a reused ephemeral
 * port after a close counts again. A connection shorter than one period can be missed.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseNetworkEntry } from "@nimbus-dev/registry-format";
import type { NetworkObserver } from "../network-observation-writer.ts";
import type { ConnectionSource, ObservedConnection } from "./types.ts";

/** The polling period. No config key changes it: there is no off switch. */
export const DEFAULT_POLL_PERIOD_MS = 250;
/** How often each declared name is looked up again. */
export const RESOLVE_REFRESH_MS = 60_000;
/** Distinct addresses kept per declared host, for the child's lifetime. */
export const MAX_ANSWERS_PER_HOST = 256;
/** Consecutive source failures after which the poller stops (the child runs on). */
export const MAX_CONSECUTIVE_POLL_ERRORS = 10;
/** New connections held while the first resolution is pending; past this they are matched at once. */
const MAX_PENDING = 4096;

export type ConnectionPollerOptions = {
  source: ConnectionSource;
  /** The policy's `permissions.network`, verbatim: the only names ever resolved. */
  declared: readonly string[];
  observer: Pick<NetworkObserver, "used" | "unmatched">;
  /** 0 starts no timer (tests drive {@link ConnectionPoller.pollNow}). */
  periodMs?: number;
  /** Tests only. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only. */
  now?: () => number;
  /** One line, without a newline. Defaults to the wrapper's stderr. */
  log?: (line: string) => void;
};

export type ConnectionPoller = {
  /** Takes one last poll synchronously, reports it, closes the source. Idempotent. */
  stop(): void;
  /** One pass now. The timer calls it; tests call it directly. */
  pollNow(): void;
};

export type DeclaredTarget = { host: string; port: number };

/**
 * Each entry parsed as the policy does (`parseNetworkEntry`, a bare host meaning 443), the host
 * lower-cased with one trailing dot dropped. A wildcard pattern (first-party policies only), an
 * entry with no usable host or port, is left out: it cannot be looked up, so nothing matches it.
 */
export function declaredTargets(declared: readonly string[]): DeclaredTarget[] {
  const out: DeclaredTarget[] = [];
  for (const raw of declared) {
    const { host: rawHost, port } = parseNetworkEntry(raw);
    const lower = rawHost.toLowerCase();
    const host = lower.endsWith(".") ? lower.slice(0, -1) : lower;
    if (host === "" || host.includes("*") || host.includes("[")) continue;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    out.push({ host, port });
  }
  return out;
}

/** `::ffff:a.b.c.d` is the IPv4 `a.b.c.d`; every other literal is kept as given. */
export function canonicalIp(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (isIP(v4) === 4) return v4;
  }
  return lower;
}

/** 127.0.0.0/8 and `::1`, after {@link canonicalIp}: the forwarder or local IPC, never a declared host. */
export function isLoopbackIp(canonical: string): boolean {
  return (isIP(canonical) === 4 && canonical.startsWith("127.")) || canonical === "::1";
}

const defaultResolve = (host: string): Promise<string[]> =>
  lookup(host, { all: true }).then((rs) => rs.map((r) => r.address));

const defaultLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const errorText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * The match table: `(address, port)` to the SET of declared hosts that resolved to that address and
 * declare that port. A set, because CDN-hosted names share addresses: every host in it may have been
 * the one, so each is reported used ("at least these").
 */
class MatchTable {
  private readonly portsByHost = new Map<string, Set<number>>();
  private readonly answersByHost = new Map<string, Set<string>>();
  private readonly hostsByTarget = new Map<string, Set<string>>();

  constructor(targets: readonly DeclaredTarget[]) {
    for (const { host, port } of targets) {
      const ports = this.portsByHost.get(host) ?? new Set<number>();
      ports.add(port);
      this.portsByHost.set(host, ports);
      this.answersByHost.set(host, new Set());
    }
  }

  /** Every distinct declared host, in declaration order. */
  hosts(): string[] {
    return [...this.portsByHost.keys()];
  }

  /** Adds answers for a host, up to {@link MAX_ANSWERS_PER_HOST}; a non-literal is ignored. */
  learn(host: string, answers: unknown): void {
    const seen = this.answersByHost.get(host);
    const ports = this.portsByHost.get(host);
    if (seen === undefined || ports === undefined || !Array.isArray(answers)) return;
    for (const a of answers) {
      if (seen.size >= MAX_ANSWERS_PER_HOST) return;
      if (typeof a !== "string" || isIP(a) === 0) continue;
      const ip = canonicalIp(a);
      if (seen.has(ip)) continue;
      seen.add(ip);
      for (const port of ports) {
        const key = `${ip}|${String(port)}`;
        const hosts = this.hostsByTarget.get(key) ?? new Set<string>();
        hosts.add(host);
        this.hostsByTarget.set(key, hosts);
      }
    }
  }

  match(ip: string, port: number): ReadonlySet<string> | undefined {
    return this.hostsByTarget.get(`${ip}|${String(port)}`);
  }
}

const connectionKey = (c: ObservedConnection): string =>
  `${String(c.pid)}|${String(c.localPort)}|${c.remoteIp}|${String(c.remotePort)}`;

export function startConnectionPoller(opts: ConnectionPollerOptions): ConnectionPoller {
  const resolve = opts.resolve ?? defaultResolve;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? defaultLog;
  const targets = declaredTargets(opts.declared);
  const table = new MatchTable(targets);
  const literals = table.hosts().filter((h) => isIP(h) !== 0);
  const names = table.hosts().filter((h) => isIP(h) === 0);
  for (const ip of literals) table.learn(ip, [ip]);

  const loggedHosts = new Set<string>();
  let previous = new Set<string>();
  let pending: ObservedConnection[] = [];
  /** The first resolution has settled, so a connection can be judged. */
  let ready = names.length === 0;
  let refreshing = false;
  let lastRefreshAt = now();
  let errors = 0;
  let running = false;
  let finished = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const report = (c: ObservedConnection): void => {
    const ip = canonicalIp(c.remoteIp);
    const hosts = table.match(ip, c.remotePort);
    if (hosts === undefined) {
      opts.observer.unmatched(ip, c.remotePort);
      return;
    }
    for (const host of hosts) opts.observer.used(host, c.remotePort);
  };

  const drain = (): void => {
    const batch = pending;
    pending = [];
    for (const c of batch) report(c);
  };

  /** One lookup of a declared name. Never rejects: a failure keeps the earlier answers. */
  const resolveOne = async (host: string): Promise<void> => {
    try {
      table.learn(host, await resolve(host));
    } catch (e) {
      if (!loggedHosts.has(host)) {
        loggedHosts.add(host);
        log(`nimbus-sandbox-wrapper: cannot resolve declared host ${host}: ${errorText(e)}`);
      }
    }
  };

  /** Looks every declared name up again, unless a refresh is still running (no overlap). */
  const refresh = (): void => {
    if (refreshing || names.length === 0) return;
    refreshing = true;
    lastRefreshAt = now();
    void Promise.all(names.map(resolveOne)).then(() => {
      refreshing = false;
      if (ready || finished) return;
      ready = true;
      try {
        drain();
      } catch {
        // Observation never throws into a timer.
      }
    });
  };

  const halt = (): void => {
    finished = true;
    if (timer !== null) clearInterval(timer);
    try {
      opts.source.close();
    } catch {
      // A source's close never throws; this keeps the promise if one ever does.
    }
  };

  /** The source's current rows, or null when it failed (counted toward the stop). */
  const read = (): ObservedConnection[] | null => {
    try {
      const rows = opts.source.poll();
      errors = 0;
      return rows;
    } catch (e) {
      errors += 1;
      if (errors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        log(
          `nimbus-sandbox-wrapper: not observing the network any more: ${String(errors)} connection-table reads failed (${errorText(e)})`,
        );
        drain();
        halt();
      }
      return null;
    }
  };

  /** Queues every connection that was not in the previous poll, loopback left out. */
  const collect = (rows: readonly ObservedConnection[]): void => {
    const current = new Set<string>();
    for (const c of rows) {
      if (isLoopbackIp(canonicalIp(c.remoteIp))) continue;
      const key = connectionKey(c);
      current.add(key);
      if (!previous.has(key)) pending.push(c);
    }
    previous = current;
  };

  const pass = (final: boolean): void => {
    if (running || finished) return;
    running = true;
    try {
      if (!final && now() - lastRefreshAt >= RESOLVE_REFRESH_MS) refresh();
      const rows = read();
      if (rows !== null) collect(rows);
      if (ready || final || pending.length > MAX_PENDING) drain();
    } catch {
      // Observation never throws into a timer or the child's exit handler.
    } finally {
      running = false;
    }
  };

  refresh();
  const periodMs = opts.periodMs ?? DEFAULT_POLL_PERIOD_MS;
  if (periodMs > 0) {
    timer = setInterval(() => pass(false), periodMs);
    timer.unref();
  }

  return {
    pollNow: () => pass(false),
    stop: () => {
      if (finished) return;
      if (timer !== null) clearInterval(timer);
      pass(true);
      if (!finished) halt();
    },
  };
}

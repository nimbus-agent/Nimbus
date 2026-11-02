/**
 * The credential-free host probe behind a registry's liveness check: "does anyone answer at the host
 * a manifest declares". It resolves the name, refuses the host outright when ANY answer is private,
 * loopback, link-local or otherwise unroutable (nothing is contacted then), and otherwise opens ONE
 * connection to the first answer by IP address and closes it. It never writes a byte to the socket.
 *
 * Bundled for the runner's Node: only `node:dns`, `node:net` and `node:tls`, no Bun API and no
 * ES2024+ runtime API (no `Promise.try`).
 */
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** Ports that speak TLS from the first byte. Any other port gets a TCP connect only. */
export const TLS_PORTS: ReadonlySet<number> = new Set([443, 465, 636, 853, 993, 995, 8443]);
export const HOST_LOOKUP_TIMEOUT_MS = 5_000;
export const HOST_CONNECT_TIMEOUT_MS = 5_000;
export const MAX_HOSTS_PER_RUN = 500;
export const HOST_CONCURRENCY = 8;

const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const V6_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
];

const BLOCKED = new BlockList();
for (const [net, prefix] of V4_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6_BLOCKED) BLOCKED.addSubnet(net, prefix, "ipv6");

/** The 8 groups of an IPv6 address in the WHATWG-normalised (hex only, compressed) form, or undefined. */
function ipv6Groups(address: string): number[] | undefined {
  let host: string;
  try {
    host = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const groups = [
    ...head,
    ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...tail,
  ];
  if (groups.length !== 8) return undefined;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  return out.some(Number.isNaN) ? undefined : out;
}

/** True only for a syntactically valid address outside every blocked range. */
export function isPublicAddress(address: string): boolean {
  const bare = address.split("%")[0] ?? "";
  const family = isIP(bare);
  if (family === 4) return !BLOCKED.check(bare, "ipv4");
  if (family !== 6) return false;
  const g = ipv6Groups(bare);
  if (g === undefined) return false;
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): judge the embedded IPv4 address.
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (zeroPrefix && (g[5] === 0xffff || g[5] === 0)) {
    const hi = g[6] ?? 0;
    const lo = g[7] ?? 0;
    const v4 = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    return !BLOCKED.check(v4, "ipv4") && (g[5] === 0xffff || !BLOCKED.check(bare, "ipv6"));
  }
  return !BLOCKED.check(bare, "ipv6");
}

export type HostProbeDeps = {
  lookup(host: string): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>>;
  connect(o: {
    address: string;
    family: 4 | 6;
    port: number;
    servername: string;
    tls: boolean;
    timeoutMs: number;
  }): Promise<boolean>;
};

/** Resolves every answer, unordered by us (`verbatim`), so a blocked one cannot hide behind a public one. */
function realLookup(host: string): Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

/**
 * One connection, closed at once. Every outcome destroys the socket. `socket.setTimeout` only emits
 * an event, so the `timeout` listener destroys, and an own timer (which also covers the TLS
 * handshake) destroys and resolves false unconditionally.
 */
function realConnect(o: Parameters<HostProbeDeps["connect"]>[0]): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = o.tls
      ? tlsConnect({ host: o.address, port: o.port, servername: o.servername })
      : netConnect({ host: o.address, port: o.port, family: o.family });
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    timer = setTimeout(() => done(false), o.timeoutMs);
    socket.setTimeout(o.timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("close", () => done(false));
    socket.on(o.tls ? "secureConnect" : "connect", () => done(true));
  });
}

export const REAL_HOST_PROBE: HostProbeDeps = { lookup: realLookup, connect: realConnect };

/** Rejects after `ms`; the timer is always cleared by the caller's `finally`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Never throws. Any private or unparsable answer fails the host with nothing contacted. */
export async function probeHost(
  entry: { host: string; port: number },
  deps: HostProbeDeps = REAL_HOST_PROBE,
  opts: { lookupTimeoutMs?: number; connectTimeoutMs?: number } = {},
): Promise<boolean> {
  const lookupMs = opts.lookupTimeoutMs ?? HOST_LOOKUP_TIMEOUT_MS;
  const connectMs = opts.connectTimeoutMs ?? HOST_CONNECT_TIMEOUT_MS;
  try {
    const answers = await withTimeout(deps.lookup(entry.host), lookupMs);
    const first = answers[0];
    if (first === undefined) return false;
    if (!answers.every((a) => isPublicAddress(a.address))) return false;
    return await withTimeout(
      deps.connect({
        address: first.address,
        family: first.family,
        port: entry.port,
        servername: entry.host,
        tls: TLS_PORTS.has(entry.port),
        timeoutMs: connectMs,
      }),
      connectMs + 500,
    );
  } catch {
    return false;
  }
}

/** Distinct host:port pairs, at most `MAX_HOSTS_PER_RUN` probed, `HOST_CONCURRENCY` at a time. */
export async function probeHosts(
  entries: ReadonlyArray<{ host: string; port: number }>,
  deps: HostProbeDeps = REAL_HOST_PROBE,
): Promise<{ declared: number; answered: number }> {
  const seen = new Map<string, { host: string; port: number }>();
  for (const e of entries) {
    const key = `${e.host}:${String(e.port)}`;
    if (!seen.has(key)) seen.set(key, e);
  }
  const distinct = [...seen.values()];
  const work = distinct.slice(0, MAX_HOSTS_PER_RUN);
  let answered = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < work.length) {
      const entry = work[next] as { host: string; port: number };
      next += 1;
      if (await probeHost(entry, deps)) answered += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, work.length) }, worker));
  return { declared: distinct.length, answered };
}

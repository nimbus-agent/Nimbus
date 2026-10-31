import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectTcp,
  createRefusalLog,
  type ForwardConnectionStats,
  type ForwardEntry,
  ForwardHost,
  type ForwardHostOptions,
  type NetSocketHandlers,
  type NetSocketLike,
  planForwardEntries,
  resolveOnHost,
  startForwardHost,
} from "./net-forward-host.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";

function policy(network: string[], over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return { id: "x", permissions: { network, filesystem: { read: [], write: [] } }, ...over };
}

function manyHosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `h${String(i)}.example.com`);
}

describe("planForwardEntries", () => {
  test("gives each distinct host its own address, so two ports on a host share one", () => {
    const entries = planForwardEntries(
      policy(["a.example.com", "b.example.com:8443", "a.example.com:8080"]),
    );
    expect(entries).toEqual([
      { host: "a.example.com", port: 443, trust: "package", loopbackIp: "127.0.0.2" },
      { host: "b.example.com", port: 8443, trust: "package", loopbackIp: "127.0.0.3" },
      { host: "a.example.com", port: 8080, trust: "package", loopbackIp: "127.0.0.2" },
    ]);
  });

  test("treats case and one trailing dot as the same host, and a repeat as one entry", () => {
    const entries = planForwardEntries(
      policy(["Jenkins.Corp.", "jenkins.corp", "jenkins.corp:443"]),
    );
    expect(entries).toEqual([
      { host: "jenkins.corp", port: 443, trust: "package", loopbackIp: "127.0.0.2" },
    ]);
  });

  test("an underscore name is an ordinary host", () => {
    expect(planForwardEntries(policy(["my_jenkins:8080"]))).toEqual([
      { host: "my_jenkins", port: 8080, trust: "package", loopbackIp: "127.0.0.2" },
    ]);
  });

  test("trust: owner by raw entry, then first-party, then package", () => {
    const entries = planForwardEntries(
      policy(["jenkins:8080", "api.example.com"], {
        ownerConfiguredNetwork: ["jenkins:8080"],
        firstPartyPolicy: true,
      }),
    );
    expect(entries.map((e) => e.trust)).toEqual(["owner", "first-party"]);
    expect(planForwardEntries(policy(["a.example.com"]))[0]?.trust).toBe("package");
  });

  test("a repeat the owner typed makes the entry the owner's, whichever came first", () => {
    const entries = planForwardEntries(
      policy(["jenkins", "jenkins:443"], { ownerConfiguredNetwork: ["jenkins:443"] }),
    );
    expect(entries.map((e) => e.trust)).toEqual(["owner"]);
  });

  test("a protonmail-shaped policy gets trust owner, so its loopback works", () => {
    const entries = planForwardEntries(
      policy(["127.0.0.1:1143"], {
        firstPartyPolicy: true,
        ownerConfiguredNetwork: ["127.0.0.1:1143"],
      }),
    );
    expect(entries).toEqual([
      { host: "127.0.0.1", port: 1143, trust: "owner", loopbackIp: "127.0.0.1" },
    ]);
  });

  test("an IP literal keeps its address and takes none from the range", () => {
    const entries = planForwardEntries(
      policy(["192.168.1.5:8080", "a.example.com", "127.0.0.1:1143"]),
    );
    expect(entries.map((e) => e.loopbackIp)).toEqual(["192.168.1.5", "127.0.0.2", "127.0.0.1"]);
  });

  test("an assigned address never lands on one a literal holds", () => {
    const entries = planForwardEntries(policy(["a.example.com", "127.0.0.2:80", "b.example.com"]));
    expect(entries.map((e) => e.loopbackIp)).toEqual(["127.0.0.3", "127.0.0.2", "127.0.0.4"]);
  });

  test("localhost is assigned an address like any name", () => {
    expect(planForwardEntries(policy(["localhost:1143"]))[0]?.loopbackIp).toBe("127.0.0.2");
  });

  test("a literal 127.0.0.53 throws, however it is spelled", () => {
    expect(() => planForwardEntries(policy(["127.0.0.53"]))).toThrow(/resolver/);
    expect(() => planForwardEntries(policy(["127.0.0.53:53"]))).toThrow(/resolver/);
    expect(() => planForwardEntries(policy(["127.0.0.53."]))).toThrow(/resolver/);
  });

  test("a literal no trust level may reach throws, however it is spelled", () => {
    for (const refused of [
      "0.0.0.0",
      "0.1.2.3",
      "0.0.0.0.",
      "169.254.169.254",
      "192.0.0.1",
      "192.0.2.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(() => planForwardEntries(policy([refused]))).toThrow(/no entry may reach/);
      expect(() => planForwardEntries(policy([`${refused}:8080`]))).toThrow(/no entry may reach/);
    }
  });

  test("a loopback, private or public literal is planned, for the trust rules to judge", () => {
    for (const literal of [
      "127.0.0.1",
      "127.0.0.2",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.5",
      "100.64.0.1",
      "8.8.8.8",
    ]) {
      expect(planForwardEntries(policy([literal]))[0]?.loopbackIp).toBe(literal);
    }
  });

  test("never assigns 127.0.0.53, and reaches 127.0.0.254 at exactly 252 hosts", () => {
    const entries = planForwardEntries(policy(manyHosts(252)));
    const ips = entries.map((e) => e.loopbackIp);
    expect(ips).not.toContain("127.0.0.53");
    expect(ips).not.toContain("127.0.0.1");
    expect(new Set(ips).size).toBe(252);
    expect(ips[0]).toBe("127.0.0.2");
    expect(ips.at(-1)).toBe("127.0.0.254");
  });

  test("throws above 252 hosts, and literals count", () => {
    expect(() => planForwardEntries(policy(manyHosts(253)))).toThrow(/252/);
    expect(() => planForwardEntries(policy([...manyHosts(252), "192.168.1.5"]))).toThrow(/252/);
  });

  test("many ports on one host count as one host", () => {
    const ports = Array.from({ length: 300 }, (_, i) => `a.example.com:${String(i + 1)}`);
    expect(new Set(planForwardEntries(policy(ports)).map((e) => e.loopbackIp)).size).toBe(1);
  });

  test("refuses an entry with no usable host or port", () => {
    for (const bad of [
      "[::1]:443",
      "::1",
      ":443",
      "a.example.com:0",
      "a.example.com:x",
      "a.example.com:70000",
    ]) {
      expect(() => planForwardEntries(policy([bad]))).toThrow(/no usable/);
    }
  });

  test("wildcards without firstPartyPolicy throw; an empty list does not", () => {
    expect(() =>
      planForwardEntries(
        policy(["a.example.com"], { firstPartyWildcardHosts: ["*.sharepoint.com"] }),
      ),
    ).toThrow(/first-party/);
    expect(
      planForwardEntries(policy(["a.example.com"], { firstPartyWildcardHosts: [] })),
    ).toHaveLength(1);
  });

  test("a policy with wildcards gets exact entries first, then 48 first-party slots on 443", () => {
    const entries = planForwardEntries(
      policy(["a.example.com:8080"], {
        firstPartyPolicy: true,
        firstPartyWildcardHosts: ["*.sharepoint.com"],
      }),
    );
    expect(entries).toHaveLength(49);
    expect(entries[0]?.host).toBe("a.example.com");
    const slots = entries.slice(1);
    expect(slots.every((e) => e.host === null && e.port === 443 && e.trust === "first-party")).toBe(
      true,
    );
    const ips = entries.map((e) => e.loopbackIp);
    expect(new Set(ips).size).toBe(49);
    expect(ips).not.toContain("127.0.0.53");
  });

  test("slots count against the 252: fewer when fewer are left, none when none are", () => {
    const withHosts = (n: number): ForwardEntry[] =>
      planForwardEntries(
        policy(manyHosts(n), {
          firstPartyPolicy: true,
          firstPartyWildcardHosts: ["*.sharepoint.com"],
        }),
      );
    expect(withHosts(204)).toHaveLength(252);
    expect(withHosts(250)).toHaveLength(252);
    expect(withHosts(252)).toHaveLength(252);
    expect(new Set(withHosts(250).map((e) => e.loopbackIp)).size).toBe(252);
  });

  test("a policy with no network plans nothing", () => {
    expect(planForwardEntries(policy([]))).toEqual([]);
  });
});

describe("createRefusalLog", () => {
  test("logs a name again only once the minute has passed", () => {
    const lines: string[] = [];
    let at = 1000;
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => at,
    );
    note("a.example.com", null, "undeclared name");
    at += 59_999;
    note("a.example.com", null, "undeclared name");
    expect(lines).toHaveLength(1);
    at += 1;
    note("a.example.com", null, "undeclared name");
    expect(lines).toHaveLength(2);
  });

  test("holds at most 1024 names, evicting the oldest", () => {
    const lines: string[] = [];
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => 0,
      Number.POSITIVE_INFINITY,
    );
    for (let i = 0; i < 1024; i += 1) note(`n${String(i)}`, null, "r");
    note("n0", null, "r");
    expect(lines).toHaveLength(1024);
    note("n1024", null, "r");
    expect(lines).toHaveLength(1025);
    note("n0", null, "r");
    expect(lines).toHaveLength(1026);
  });

  test("2000 distinct names: 60 lines and one notice, then logging resumes a minute later", () => {
    const lines: string[] = [];
    let at = 0;
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => at,
    );
    for (let i = 0; i < 2000; i += 1) note(`n${String(i)}`, null, "r");
    expect(lines).toHaveLength(61);
    expect(lines[59]).toBe("net-forward: n59: r");
    expect(lines[60]).toBe("net-forward: further refusals suppressed this minute");
    at += 60_000;
    for (let i = 2000; i < 2100; i += 1) note(`n${String(i)}`, null, "r");
    expect(lines).toHaveLength(61 + 61);
    expect(lines[61]).toBe("net-forward: n2000: r");
    expect(lines.at(-1)).toBe("net-forward: further refusals suppressed this minute");
  });

  test("a name the budget held back was not recorded, so it can log inside its own minute", () => {
    const lines: string[] = [];
    let at = 0;
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => at,
    );
    for (let i = 0; i < 60; i += 1) note(`n${String(i)}`, null, "r");
    at = 59_000;
    note("held-back", null, "r");
    expect(lines.at(-1)).toBe("net-forward: further refusals suppressed this minute");
    at = 60_000;
    note("held-back", null, "r");
    expect(lines.at(-1)).toBe("net-forward: held-back: r");
  });

  test("a repeat inside a name's minute spends none of the budget", () => {
    const lines: string[] = [];
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => 0,
    );
    for (let i = 0; i < 1000; i += 1) note("same", null, "r");
    for (let i = 0; i < 59; i += 1) note(`n${String(i)}`, null, "r");
    expect(lines).toHaveLength(60);
    expect(lines.join("\n")).not.toContain("suppressed");
  });

  test("a line holds the name, the port and the reason", () => {
    const lines: string[] = [];
    const note = createRefusalLog(
      (l) => lines.push(l),
      () => 0,
    );
    note("a.example.com", 8443, "refused address");
    expect(lines).toEqual(["net-forward: a.example.com:8443: refused address"]);
  });
});

/** A remote socket with hand-driven events, whose `write` takes as much as `accept` allows. */
class FakeRemote implements NetSocketLike {
  received: Uint8Array[] = [];
  handlers: NetSocketHandlers | null = null;
  accept = Number.POSITIVE_INFINITY;
  writeResult: number | null = null;
  finCount = 0;
  closeCount = 0;
  pauseCount = 0;
  resumeCount = 0;

  write(data: Uint8Array): number {
    if (this.writeResult !== null) return this.writeResult;
    const n = Math.min(this.accept, data.length);
    if (n > 0) this.received.push(new Uint8Array(data.subarray(0, n)));
    return n;
  }
  shutdownWrite(): void {
    this.finCount += 1;
  }
  close(): void {
    this.closeCount += 1;
  }
  pause(): void {
    this.pauseCount += 1;
  }
  resume(): void {
    this.resumeCount += 1;
  }
  setHandlers(handlers: NetSocketHandlers): void {
    this.handlers = handlers;
  }
  text(): string {
    return Buffer.concat(this.received).toString("latin1");
  }
  byteCount(): number {
    return this.received.reduce((sum, c) => sum + c.length, 0);
  }
  /** Sends bytes from the remote host toward the child. */
  push(data: string | Uint8Array): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.handlers?.data(bytes);
  }
}

type TestClient = {
  socket: Awaited<ReturnType<typeof Bun.connect<null>>>;
  bytes: () => Buffer;
  isClosed: () => boolean;
  sawEnd: () => boolean;
};

async function openClient(socketPath: string, onDrain?: () => void): Promise<TestClient> {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let ended = false;
  const socket = await Bun.connect<null>({
    unix: socketPath,
    allowHalfOpen: true,
    data: null,
    socket: {
      data(_s, chunk) {
        chunks.push(new Uint8Array(chunk));
      },
      drain() {
        onDrain?.();
      },
      end() {
        ended = true;
      },
      close() {
        closed = true;
      },
      error() {
        closed = true;
      },
    },
  });
  return {
    socket,
    bytes: () => Buffer.concat(chunks),
    isClosed: () => closed,
    sawEnd: () => ended,
  };
}

async function waitFor(what: string, condition: () => boolean, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await Bun.sleep(2);
  }
}

function tcpHeader(index: number): Uint8Array {
  return Uint8Array.from([0x54, index >> 8, index & 0xff]);
}

function dnsQuery(name: string, qtype: number): Uint8Array {
  const labels = name.split(".").flatMap((l) => [l.length, ...Buffer.from(l, "latin1")]);
  return Uint8Array.from([
    0xbe,
    0xef,
    0x01,
    0x00,
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0,
    ...labels,
    0,
    0,
    qtype,
    0,
    1,
  ]);
}

function dnsFrame(datagram: Uint8Array): Uint8Array {
  return Uint8Array.from([0x44, 0, 0, datagram.length >> 8, datagram.length & 0xff, ...datagram]);
}

const TYPE_A = 1;
const TYPE_AAAA = 28;

type DnsReply = { rcode: number; address: string | null };

function parseDnsReply(frame: Buffer): DnsReply {
  expect(frame.readUInt16BE(0)).toBe(frame.length - 2);
  const reply = frame.subarray(2);
  const rcode = (reply[3] ?? 0) & 0x0f;
  const answers = reply.readUInt16BE(6);
  return { rcode, address: answers === 0 ? null : [...reply.subarray(-4)].join(".") };
}

const SLOW = 60_000;

/** A unix side for driving `ForwardHost` with no socket at all. */
function fakeSide(over: { close?: () => void } = {}) {
  const side = {
    closeCount: 0,
    write: (data: Uint8Array): number => data.length,
    shutdownWrite: (): void => undefined,
    close: (): void => {
      side.closeCount += 1;
      over.close?.();
    },
    pause: (): void => undefined,
    resume: (): void => undefined,
  };
  return side;
}

describe("ForwardHost, with no socket", () => {
  const ENTRY: ForwardEntry = {
    host: "api.example.com",
    port: 443,
    trust: "package",
    loopbackIp: "127.0.0.2",
  };
  const base = {
    socketPath: "unused",
    entries: [ENTRY],
    resolve: () => Promise.resolve(["93.184.216.34"]),
    log: () => undefined,
  };

  test("a dial in flight holds its slot after the child's side closes", async () => {
    let dials = 0;
    const host = new ForwardHost({
      ...base,
      connect: () => {
        dials += 1;
        return new Promise<NetSocketLike>(() => undefined);
      },
    });
    const conns = Array.from({ length: 256 }, () => {
      const conn = host.accept(fakeSide());
      if (conn === null) throw new Error("turned away below the cap");
      conn.onData(tcpHeader(0));
      return conn;
    });
    await waitFor("every dial in flight", () => dials === 256);
    for (const conn of conns) conn.onClose();
    expect(host.accept(fakeSide())).toBeNull();
  });

  /** A relay running over a fake side and a fake remote, and what it reported on closing. */
  async function relayOver(side: ReturnType<typeof fakeSide>, remote: FakeRemote) {
    const reports: ForwardConnectionStats[] = [];
    const host = new ForwardHost({
      ...base,
      connect: () => Promise.resolve(remote),
      onConnectionClosed: (_entry, stats) => reports.push(stats),
    });
    const conn = host.accept(side);
    if (conn === null) throw new Error("turned away");
    conn.onData(tcpHeader(0));
    await waitFor("the relay", () => remote.handlers !== null);
    return { host, conn, reports };
  }

  test("a remote whose close throws still closes the child's side and reports", async () => {
    const side = fakeSide();
    const remote = new FakeRemote();
    remote.close = () => {
      remote.closeCount += 1;
      throw new Error("remote close");
    };
    const { host, conn, reports } = await relayOver(side, remote);
    host.closeConn(conn);
    expect(remote.closeCount).toBe(1);
    expect(side.closeCount).toBe(1);
    expect(reports).toHaveLength(1);
  });

  test("a child's side whose close throws still closes the remote and reports", async () => {
    const side = fakeSide({
      close: () => {
        throw new Error("side close");
      },
    });
    const remote = new FakeRemote();
    const { host, conn, reports } = await relayOver(side, remote);
    host.closeConn(conn);
    expect(remote.closeCount).toBe(1);
    expect(side.closeCount).toBe(1);
    expect(reports).toHaveLength(1);
  });
});

// This code runs only on Linux, so the real-socket tests do too.
describe.skipIf(process.platform !== "linux")("startForwardHost", () => {
  let dir: string;
  let socketPath: string;
  let stop: (() => void) | null;
  const clients: TestClient[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nfh-"));
    socketPath = join(dir, "s", "f.sock");
    stop = null;
  });

  afterEach(() => {
    for (const c of clients.splice(0)) c.socket.terminate();
    stop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  type Harness = {
    remotes: FakeRemote[];
    connects: [string, number][];
    resolves: string[];
    logs: string[];
    refused: string[];
    closed: { entry: ForwardEntry; stats: ForwardConnectionStats }[];
    client: (onDrain?: () => void) => Promise<TestClient>;
  };

  const ENTRY: ForwardEntry = {
    host: "api.example.com",
    port: 8443,
    trust: "package",
    loopbackIp: "127.0.0.2",
  };

  function start(over: Partial<ForwardHostOptions> = {}): Harness {
    const h: Harness = {
      remotes: [],
      connects: [],
      resolves: [],
      logs: [],
      refused: [],
      closed: [],
      client: async (onDrain) => {
        const c = await openClient(socketPath, onDrain);
        clients.push(c);
        return c;
      },
    };
    const host = startForwardHost({
      socketPath,
      entries: [ENTRY],
      resolve: (name) => {
        h.resolves.push(name);
        return Promise.resolve(["93.184.216.34"]);
      },
      connect: (ip, port) => {
        h.connects.push([ip, port]);
        const remote = new FakeRemote();
        h.remotes.push(remote);
        return Promise.resolve(remote);
      },
      log: (line) => h.logs.push(line),
      onRefusedName: (name) => h.refused.push(name),
      onConnectionClosed: (entry, stats) => h.closed.push({ entry, stats }),
      ...over,
    });
    stop = () => host.close();
    return h;
  }

  async function dns(h: Harness, query: Uint8Array): Promise<DnsReply> {
    const c = await h.client();
    c.socket.write(dnsFrame(query));
    await waitFor("the DNS reply and close", c.isClosed);
    return parseDnsReply(c.bytes());
  }

  /** Retries until the host answers rather than turning the connection away. */
  async function dnsOnceASlotIsFree(h: Harness): Promise<Uint8Array> {
    for (;;) {
      const c = await h.client();
      c.socket.write(dnsFrame(dnsQuery("api.example.com", TYPE_A)));
      await waitFor("an answer or a refusal", c.isClosed);
      if (c.bytes().length > 0) return c.bytes();
      await Bun.sleep(2);
    }
  }

  /** A connected relay: the client past its header, and the remote it reached. */
  async function relay(h: Harness, index = 0): Promise<{ c: TestClient; remote: FakeRemote }> {
    const before = h.remotes.length;
    const c = await h.client();
    c.socket.write(tcpHeader(index));
    await waitFor(
      "the relay",
      () => h.remotes[before]?.handlers !== null && h.remotes.length > before,
    );
    const remote = h.remotes[before];
    if (remote === undefined) throw new Error("no remote");
    return { c, remote };
  }

  test(
    "T with a valid index connects to the allowed address and port, and relays both ways",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      expect(h.resolves).toEqual(["api.example.com"]);
      expect(h.connects).toEqual([["93.184.216.34", 8443]]);
      c.socket.write("hello host");
      await waitFor("bytes at the host", () => remote.text() === "hello host");
      remote.push("hello child");
      await waitFor("bytes at the child", () => c.bytes().toString() === "hello child");
    },
    SLOW,
  );

  test(
    "bytes sent with the header, or while dialing, reach the host in order",
    async () => {
      const lookups: ((v: string[]) => void)[] = [];
      const h = start({
        resolve: () =>
          new Promise((resolve) => {
            lookups.push(resolve);
          }),
      });
      const c = await h.client();
      c.socket.write(Uint8Array.from([...tcpHeader(0), 0x61]));
      await waitFor("the lookup", () => lookups.length > 0);
      c.socket.write("bc");
      lookups[0]?.(["93.184.216.34"]);
      await waitFor("the remote", () => h.remotes.length === 1);
      await waitFor("bytes at the host", () => h.remotes[0]?.text() === "abc");
      expect(h.remotes[0]?.text()).toBe("abc");
    },
    SLOW,
  );

  for (const index of [1, 0xffff]) {
    test(
      `T with index ${String(index)}, past the end, closes, and connect is never called`,
      async () => {
        const h = start();
        const c = await h.client();
        c.socket.write(tcpHeader(index));
        await waitFor("the close", c.isClosed);
        expect(h.resolves).toEqual([]);
        expect(h.connects).toEqual([]);
      },
      SLOW,
    );
  }

  test(
    "a byte stream that is neither T nor D closes",
    async () => {
      const h = start();
      const c = await h.client();
      c.socket.write("GET / HTTP/1.1\r\n");
      await waitFor("the close", c.isClosed);
      expect(h.connects).toEqual([]);
    },
    SLOW,
  );

  test(
    "a header split across writes still works",
    async () => {
      const h = start();
      const c = await h.client();
      c.socket.write(Uint8Array.from([0x54]));
      await Bun.sleep(5);
      c.socket.write(Uint8Array.from([0]));
      await Bun.sleep(5);
      c.socket.write(Uint8Array.from([0, 0x7a]));
      await waitFor("the remote", () => h.remotes.length === 1);
      await waitFor("bytes at the host", () => h.remotes[0]?.text() === "z");
      expect(h.remotes[0]?.text()).toBe("z");
    },
    SLOW,
  );

  test(
    "every answer refused closes with one log line, and connect is never called",
    async () => {
      const h = start({
        resolve: () => Promise.resolve(["169.254.169.254", "10.0.0.1", "127.0.0.1"]),
      });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the close", c.isClosed);
      expect(h.connects).toEqual([]);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("api.example.com");
      expect(h.logs[0]).toContain("8443");
      expect(h.logs[0]).toContain("refused address");
      expect(h.logs[0]).not.toContain("169.254");
      expect(h.refused).toEqual(["api.example.com"]);
      expect(h.closed).toEqual([]);
    },
    SLOW,
  );

  test(
    "only a kept address is dialed, in order, stopping at the first success",
    async () => {
      const h = start({
        resolve: () =>
          Promise.resolve(["169.254.169.254", "1.1.1.1", "10.0.0.1", "8.8.8.8", "9.9.9.9"]),
        connect: (ip, port) => {
          h.connects.push([ip, port]);
          if (ip === "1.1.1.1") return Promise.reject(new Error("refused"));
          const remote = new FakeRemote();
          h.remotes.push(remote);
          return Promise.resolve(remote);
        },
      });
      await relay(h);
      expect(h.connects).toEqual([
        ["1.1.1.1", 8443],
        ["8.8.8.8", 8443],
      ]);
      expect(h.logs).toEqual([]);
    },
    SLOW,
  );

  test(
    "the entry's trust decides the answer: an owner entry may reach a private address",
    async () => {
      const h = start({
        entries: [{ ...ENTRY, trust: "owner" }],
        resolve: () => Promise.resolve(["10.0.0.1"]),
      });
      await relay(h);
      expect(h.connects).toEqual([["10.0.0.1", 8443]]);
    },
    SLOW,
  );

  test(
    "connect rejecting closes with one log line, and the host takes the next connection",
    async () => {
      let fail = true;
      const h = start({
        connect: (ip, port) => {
          if (fail) return Promise.reject(new Error("nope 93.184.216.34"));
          h.connects.push([ip, port]);
          const remote = new FakeRemote();
          h.remotes.push(remote);
          return Promise.resolve(remote);
        },
      });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the close", c.isClosed);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("connect failed");
      expect(h.logs[0]).not.toContain("93.184");
      fail = false;
      await relay(h);
      expect(h.connects).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "resolve rejecting closes with one log line",
    async () => {
      const h = start({ resolve: () => Promise.reject(new Error("ENOTFOUND")) });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the close", c.isClosed);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("lookup failed");
      expect(h.connects).toEqual([]);
    },
    SLOW,
  );

  test(
    "a connect that throws synchronously is a failed dial, not a dead host",
    async () => {
      const h = start({
        connect: () => {
          throw new Error("sync");
        },
      });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the close", c.isClosed);
      expect((await dns(h, dnsQuery("nope.example.com", TYPE_A))).rcode).toBe(3);
    },
    SLOW,
  );

  test(
    "256 open connections, then the 257th closes at once; after one closes a new one works",
    async () => {
      const h = start({ headerTimeoutMs: 600_000 });
      const open: TestClient[] = [];
      for (let i = 0; i < 256; i += 1) open.push(await h.client());
      // A round trip per client would be slow; the last one's header proves all 256 were accepted.
      open[255]?.socket.write(tcpHeader(0));
      await waitFor("the 256th accepted", () => h.remotes.length === 1);
      const over = await h.client();
      await waitFor("the 257th closed", over.isClosed);
      expect(h.remotes).toHaveLength(1);

      open[0]?.socket.terminate();
      await dnsOnceASlotIsFree(h);
      expect(open.slice(1).every((c) => !c.isClosed())).toBe(true);
    },
    SLOW,
  );

  test(
    "a dial that settles after the child hung up leaves its socket closed and its slot free",
    async () => {
      const pending: ((r: NetSocketLike) => void)[] = [];
      const h = start({
        headerTimeoutMs: 600_000,
        connect: () => new Promise((resolve) => pending.push(resolve)),
      });
      const open: TestClient[] = [];
      for (let i = 0; i < 256; i += 1) {
        const c = await h.client();
        c.socket.write(tcpHeader(0));
        open.push(c);
      }
      await waitFor("every dial in flight", () => pending.length === 256);
      for (const c of open) c.socket.terminate();
      await waitFor("the child's closes seen", () => open.every((c) => c.isClosed()));

      const late = pending.map(() => new FakeRemote());
      pending.forEach((settle, i) => {
        const remote = late[i];
        if (remote !== undefined) settle(remote);
      });
      await waitFor("every late socket closed", () => late.every((r) => r.closeCount > 0));
      expect(late.every((r) => r.closeCount > 0)).toBe(true);

      const answer = await dnsOnceASlotIsFree(h);
      expect(answer.length).toBeGreaterThan(0);
    },
    SLOW,
  );

  test(
    "D for an undeclared name: NXDOMAIN, onRefusedName called, one log line",
    async () => {
      const h = start();
      expect(await dns(h, dnsQuery("evil.example.org", TYPE_A))).toEqual({
        rcode: 3,
        address: null,
      });
      expect(h.refused).toEqual(["evil.example.org"]);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("evil.example.org");
      expect(h.connects).toEqual([]);
      expect(h.resolves).toEqual([]);
    },
    SLOW,
  );

  test(
    "the same refused name 1000 times logs once per minute, whatever the callback count",
    async () => {
      let at = 5000;
      const h = start({ now: () => at });
      const c0 = dnsQuery("evil.example.org", TYPE_A);
      for (let i = 0; i < 1000; i += 1) await dns(h, c0);
      expect(h.logs).toHaveLength(1);
      expect(h.refused).toHaveLength(1000);
      at += 60_000;
      await dns(h, c0);
      expect(h.logs).toHaveLength(2);
    },
    SLOW,
  );

  test(
    "a refused name reaches the log sanitised",
    async () => {
      const h = start();
      const raw = Uint8Array.from([
        0xbe,
        0xef,
        0x01,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        9,
        ...Buffer.from('a"b c=d\tx', "latin1"),
        0,
        0,
        1,
        0,
        1,
      ]);
      expect((await dns(h, raw)).rcode).toBe(3);
      expect(h.logs).toHaveLength(1);
      expect(h.logs[0]).toContain("a?b?c?dx");
      expect(h.logs[0]).not.toContain('"');
      expect(h.refused).toEqual(["a?b?c?dx"]);
    },
    SLOW,
  );

  test(
    "the log never contains relayed bytes",
    async () => {
      const h = start({
        connect: (ip, port) => {
          h.connects.push([ip, port]);
          if (h.connects.length === 2) return Promise.reject(new Error("SECRET-ERROR"));
          const remote = new FakeRemote();
          h.remotes.push(remote);
          return Promise.resolve(remote);
        },
      });
      const { c, remote } = await relay(h);
      c.socket.write("SECRET-TO-HOST");
      await waitFor("bytes at the host", () => remote.text() === "SECRET-TO-HOST");
      remote.push("SECRET-FROM-HOST");
      await waitFor("bytes at the child", () => c.bytes().length > 0);
      c.socket.terminate();
      await waitFor("the relay closed", () => h.closed.length === 1);
      const failed = await h.client();
      failed.socket.write(
        Uint8Array.from([...tcpHeader(0), ...Buffer.from("SECRET-WHILE-DIALING")]),
      );
      await waitFor("the failed dial closed", failed.isClosed);
      const rude = await h.client();
      rude.socket.write("SECRET-AS-HEADER");
      await waitFor("the bad header closed", rude.isClosed);
      expect(h.logs.length).toBeGreaterThan(0);
      expect(h.logs.join("\n")).not.toContain("SECRET");
    },
    SLOW,
  );

  test(
    "onConnectionClosed fires once per finished T connection, with counts in both directions",
    async () => {
      let at = 1000;
      const h = start({ now: () => at });
      const { c, remote } = await relay(h);
      c.socket.write("12345");
      await waitFor("bytes at the host", () => remote.byteCount() === 5);
      remote.push("abc");
      await waitFor("bytes at the child", () => c.bytes().length === 3);
      at = 3500;
      c.socket.terminate();
      await waitFor("the report", () => h.closed.length > 0);
      await Bun.sleep(10);
      expect(h.closed).toEqual([
        {
          entry: ENTRY,
          stats: { startedAtMs: 1000, durationMs: 2500, bytesToHost: 5, bytesFromHost: 3 },
        },
      ]);
      expect(remote.closeCount).toBeGreaterThan(0);
    },
    SLOW,
  );

  test(
    "nothing is reported for a T connection that never relayed, or for D",
    async () => {
      const h = start({ resolve: () => Promise.resolve(["169.254.169.254"]) });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the close", c.isClosed);
      await dns(h, dnsQuery("api.example.com", TYPE_A));
      expect(h.closed).toEqual([]);
    },
    SLOW,
  );

  test(
    "throwing callbacks never take down the host",
    async () => {
      const h = start({
        log: () => {
          throw new Error("log");
        },
        onRefusedName: () => {
          throw new Error("refused");
        },
        onConnectionClosed: () => {
          throw new Error("closed");
        },
      });
      expect((await dns(h, dnsQuery("evil.example.org", TYPE_A))).rcode).toBe(3);
      const { c } = await relay(h);
      c.socket.terminate();
      await waitFor("the close", c.isClosed);
      await Bun.sleep(10);
      const again = await relay(h);
      expect(again.remote.closeCount).toBe(0);
    },
    SLOW,
  );

  test(
    "half-close from the child relays: the host still answers, then both close",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      c.socket.write("request");
      await waitFor("the request", () => remote.text() === "request");
      c.socket.shutdown();
      await waitFor("FIN at the host", () => remote.finCount === 1);
      expect(remote.closeCount).toBe(0);
      remote.push("response");
      await waitFor("the response", () => c.bytes().toString() === "response");
      expect(c.isClosed()).toBe(false);
      remote.handlers?.end();
      await waitFor("the child's close", () => c.sawEnd() || c.isClosed());
      await waitFor("the remote closed", () => remote.closeCount > 0);
      expect(h.closed).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "half-close from the host relays: the child can still send, then both close",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      remote.handlers?.end();
      await waitFor("FIN at the child", c.sawEnd);
      expect(remote.closeCount).toBe(0);
      c.socket.write("late");
      await waitFor("late bytes at the host", () => remote.text() === "late");
      c.socket.shutdown();
      await waitFor("the remote closed", () => remote.closeCount > 0);
      expect(remote.finCount).toBe(1);
      expect(h.closed).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a FIN waits for what is queued, so a half-close loses no bytes",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      remote.accept = 2;
      c.socket.write("abcdef");
      await waitFor("the first bytes", () => remote.byteCount() === 2);
      c.socket.shutdown();
      await Bun.sleep(20);
      expect(remote.finCount).toBe(0);
      remote.accept = Number.POSITIVE_INFINITY;
      remote.handlers?.drain();
      expect(remote.text()).toBe("abcdef");
      await waitFor("the FIN", () => remote.finCount === 1);
    },
    SLOW,
  );

  test(
    "the child closing outright still delivers what it sent, then FIN and close",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      remote.accept = 2;
      c.socket.write("abcdef");
      await waitFor("the first bytes", () => remote.byteCount() === 2);
      c.socket.terminate();
      await waitFor("the child's close", c.isClosed);
      await Bun.sleep(20);
      expect(remote.closeCount).toBe(0);
      remote.accept = Number.POSITIVE_INFINITY;
      remote.handlers?.drain();
      expect(remote.text()).toBe("abcdef");
      expect(remote.finCount).toBe(1);
      await waitFor("the remote closed", () => remote.closeCount > 0);
      expect(h.closed[0]?.stats.bytesToHost).toBe(6);
    },
    SLOW,
  );

  test(
    "the remote closing delivers what it sent, then closes the child",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      remote.push("last words");
      remote.handlers?.close();
      await waitFor("the close", c.isClosed);
      expect(c.bytes().toString()).toBe("last words");
      expect(h.closed).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a write that fails outright closes both sides",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      remote.writeResult = -1;
      c.socket.write("x");
      await waitFor("the close", c.isClosed);
      expect(remote.closeCount).toBeGreaterThan(0);
      expect(h.closed).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a slow child: the relay pauses the host rather than buffering past 1 MiB",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      c.socket.pause();
      await Bun.sleep(5);
      const chunk = new Uint8Array(64 * 1024).map((_, i) => i % 251);
      let pushed = 0;
      while (remote.pauseCount === 0 && pushed < 64 * 1024 * 1024) {
        remote.push(chunk);
        pushed += chunk.length;
      }
      expect(remote.pauseCount).toBe(1);
      // 1 MiB queued, one chunk over it, and what the kernel took for a stopped reader.
      expect(pushed).toBeLessThan(4 * 1024 * 1024);
      expect(remote.resumeCount).toBe(0);
      c.socket.resume();
      await waitFor("every byte at the child", () => c.bytes().length === pushed);
      await waitFor("the host resumed", () => remote.resumeCount === 1);
      const out = c.bytes();
      for (let i = 0; i < pushed; i += 65_537) expect(out[i]).toBe((i % chunk.length) % 251);
      remote.handlers?.close();
      await waitFor("the close", c.isClosed);
      expect(h.closed[0]?.stats.bytesFromHost).toBe(pushed);
    },
    SLOW,
  );

  test(
    "a slow host: the relay stops reading the child, and nothing is lost when it recovers",
    async () => {
      const h = start();
      const total = 8 * 1024 * 1024;
      const chunk = new Uint8Array(64 * 1024).map((_, i) => i % 251);
      let accepted = 0;
      let lastProgressAt = 0;
      const pumpClient = (): void => {
        while (accepted < total) {
          const offset = accepted % chunk.length;
          const n = c.socket.write(chunk.subarray(offset));
          if (n <= 0) return;
          accepted += n;
          lastProgressAt = Date.now();
        }
      };
      const handle = await relayWithDrain(h, () => pumpClient());
      const c = handle.c;
      const remote = handle.remote;
      remote.accept = 0;
      pumpClient();
      // Stalled means no progress for a while. A slow machine can only make this look stalled
      // early, which weakens the bound below but cannot fail it.
      await waitFor("the child stalled", () => Date.now() - lastProgressAt > 300);
      expect(accepted).toBeLessThan(total);
      expect(accepted).toBeLessThan(4 * 1024 * 1024);
      remote.accept = Number.POSITIVE_INFINITY;
      remote.handlers?.drain();
      await waitFor("every byte at the host", () => remote.byteCount() === total);
      const got = Buffer.concat(remote.received);
      for (let i = 0; i < total; i += 65_537) expect(got[i]).toBe((i % chunk.length) % 251);
    },
    SLOW,
  );

  async function relayWithDrain(
    h: Harness,
    onDrain: () => void,
  ): Promise<{ c: TestClient; remote: FakeRemote }> {
    const c = await h.client(onDrain);
    c.socket.write(tcpHeader(0));
    await waitFor("the relay", () => h.remotes.length === 1 && h.remotes[0]?.handlers !== null);
    const remote = h.remotes[0];
    if (remote === undefined) throw new Error("no remote");
    return { c, remote };
  }

  test(
    "close(): the socket file is gone, connections end, and close is idempotent",
    async () => {
      const h = start();
      const { c, remote } = await relay(h);
      const idle = await h.client();
      expect(existsSync(socketPath)).toBe(true);
      stop?.();
      expect(existsSync(socketPath)).toBe(false);
      stop?.();
      await waitFor("the relay closed", c.isClosed);
      await waitFor("the idle connection closed", idle.isClosed);
      expect(remote.closeCount).toBeGreaterThan(0);
      await expect(openClient(socketPath)).rejects.toThrow();
    },
    SLOW,
  );

  test(
    "a dial finishing after close() gets no relay",
    async () => {
      const dials: ((r: NetSocketLike) => void)[] = [];
      const h = start({
        connect: () =>
          new Promise((resolve) => {
            dials.push(resolve);
          }),
      });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the dial", () => dials.length > 0);
      stop?.();
      const late = new FakeRemote();
      dials[0]?.(late);
      await waitFor("the late socket closed", () => late.closeCount > 0);
      expect(late.handlers).toBeNull();
      expect(h.closed).toEqual([]);
    },
    SLOW,
  );

  test("the socket's directory is created private, and a shared one is refused", () => {
    start();
    expect(statSync(join(dir, "s")).mode & 0o777).toBe(0o700);
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    expect(() =>
      startForwardHost({
        socketPath: join(shared, "f.sock"),
        entries: [],
        resolve: () => Promise.resolve([]),
        connect: () => Promise.reject(new Error("no")),
        log: () => undefined,
      }),
    ).toThrow(/not private/);
    expect(existsSync(join(shared, "f.sock"))).toBe(false);
  });

  test("a second host on a live socket path refuses to start", () => {
    start();
    expect(() =>
      startForwardHost({
        socketPath,
        entries: [],
        resolve: () => Promise.resolve([]),
        connect: () => Promise.reject(new Error("no")),
        log: () => undefined,
      }),
    ).toThrow();
  });

  test(
    "no complete header inside the bound: closes",
    async () => {
      const h = start({ headerTimeoutMs: 20 });
      const silent = await h.client();
      const partial = await h.client();
      partial.socket.write(Uint8Array.from([0x54, 0]));
      await waitFor("the silent connection closed", silent.isClosed);
      await waitFor("the partial header closed", partial.isClosed);
      expect(h.connects).toEqual([]);
    },
    SLOW,
  );

  test(
    "no complete datagram inside the bound: closes",
    async () => {
      const h = start({ headerTimeoutMs: 20 });
      const c = await h.client();
      c.socket.write(Uint8Array.from([0x44, 0, 0, 0, 40, 1, 2, 3]));
      await waitFor("the close", c.isClosed);
      expect(c.bytes()).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "a relayed connection has no timeout, however short the header bound",
    async () => {
      const h = start({ headerTimeoutMs: 500 });
      const { c, remote } = await relay(h);
      await Bun.sleep(1000);
      expect(c.isClosed()).toBe(false);
      c.socket.write("still here");
      await waitFor("bytes at the host", () => remote.text() === "still here");
    },
    SLOW,
  );

  test(
    "a dial slower than the bound is not closed by it",
    async () => {
      const lookups: ((v: string[]) => void)[] = [];
      const h = start({
        headerTimeoutMs: 500,
        resolve: () =>
          new Promise((resolve) => {
            lookups.push(resolve);
          }),
      });
      const c = await h.client();
      c.socket.write(tcpHeader(0));
      await waitFor("the lookup", () => lookups.length > 0);
      await Bun.sleep(1000);
      expect(c.isClosed()).toBe(false);
      lookups[0]?.(["93.184.216.34"]);
      await waitFor("the remote", () => h.remotes.length === 1);
    },
    SLOW,
  );

  describe("the D frame", () => {
    async function expectClosedWithoutReply(frame: Uint8Array): Promise<void> {
      const h = start();
      const c = await h.client();
      c.socket.write(frame);
      await waitFor("the close", c.isClosed);
      expect(c.bytes()).toHaveLength(0);
      expect(h.logs).toEqual([]);
    }

    test(
      "a zero length closes",
      () => expectClosedWithoutReply(Uint8Array.from([0x44, 0, 0, 0, 0])),
      SLOW,
    );

    test(
      "a nonzero index closes",
      () =>
        expectClosedWithoutReply(
          Uint8Array.from([0x44, 0, 1, ...dnsFrame(dnsQuery("a.example.com", TYPE_A)).subarray(3)]),
        ),
      SLOW,
    );

    test(
      "bytes past the stated length close",
      () =>
        expectClosedWithoutReply(
          Uint8Array.from([...dnsFrame(dnsQuery("a.example.com", TYPE_A)), 7]),
        ),
      SLOW,
    );

    test(
      "a malformed datagram closes",
      () => expectClosedWithoutReply(Uint8Array.from([0x44, 0, 0, 0, 3, 1, 2, 3])),
      SLOW,
    );

    test(
      "a stream past the longest datagram closes",
      async () => {
        // The bound is out of reach, so only the length rule can close this.
        const h = start({ headerTimeoutMs: 600_000 });
        const c = await h.client();
        c.socket.write(Uint8Array.from([0x44, 0, 0, 0xff, 0xff]));
        const chunk = new Uint8Array(16 * 1024);
        const deadline = Date.now() + 45_000;
        while (!c.isClosed()) {
          if (Date.now() > deadline) throw new Error("the host never closed the long stream");
          c.socket.write(chunk);
          await Bun.sleep(1);
        }
        expect(c.bytes()).toHaveLength(0);
      },
      SLOW,
    );

    test(
      "a frame split across writes still works",
      async () => {
        const h = start();
        const c = await h.client();
        const frame = dnsFrame(dnsQuery("api.example.com", TYPE_A));
        for (const part of [
          frame.subarray(0, 1),
          frame.subarray(1, 4),
          frame.subarray(4, 9),
          frame.subarray(9),
        ]) {
          c.socket.write(part);
          await Bun.sleep(5);
        }
        await waitFor("the close", c.isClosed);
        expect(parseDnsReply(c.bytes())).toEqual({ rcode: 0, address: "127.0.0.2" });
      },
      SLOW,
    );
  });

  describe("names", () => {
    const WILDCARD = "*.sharepoint.com";
    const SLOT = (loopbackIp: string): ForwardEntry => ({
      host: null,
      port: 443,
      trust: "first-party",
      loopbackIp,
    });
    const EXACT: ForwardEntry = {
      host: "tenant.sharepoint.com",
      port: 443,
      trust: "first-party",
      loopbackIp: "127.0.0.2",
    };
    const SLOTS = [SLOT("127.0.0.3"), SLOT("127.0.0.4")];

    function pool(over: Partial<ForwardHostOptions> = {}): Harness {
      return start({ entries: [EXACT, ...SLOTS], wildcards: [WILDCARD], ...over });
    }

    test(
      "an exact name gets its address, case-insensitively and with a trailing dot in the plan",
      async () => {
        const h = start({ entries: [{ ...ENTRY, host: "API.example.com." }] });
        expect(await dns(h, dnsQuery("api.EXAMPLE.com", TYPE_A))).toEqual({
          rcode: 0,
          address: "127.0.0.2",
        });
        expect(await dns(h, dnsQuery("api.example.com", TYPE_AAAA))).toEqual({
          rcode: 0,
          address: null,
        });
      },
      SLOW,
    );

    test(
      "A for a matching name takes the next slot, and the same name keeps it",
      async () => {
        const h = pool();
        expect((await dns(h, dnsQuery("a.sharepoint.com", TYPE_A))).address).toBe("127.0.0.3");
        expect((await dns(h, dnsQuery("b.sharepoint.com", TYPE_A))).address).toBe("127.0.0.4");
        expect((await dns(h, dnsQuery("a.sharepoint.com", TYPE_A))).address).toBe("127.0.0.3");
      },
      SLOW,
    );

    test(
      "AAAA first takes no slot, and a different name's A then gets the first free one",
      async () => {
        const h = pool();
        expect(await dns(h, dnsQuery("a.sharepoint.com", TYPE_AAAA))).toEqual({
          rcode: 0,
          address: null,
        });
        expect((await dns(h, dnsQuery("b.sharepoint.com", TYPE_A))).address).toBe("127.0.0.3");
      },
      SLOW,
    );

    test(
      "A for a name matching no wildcard: NXDOMAIN",
      async () => {
        const h = pool();
        expect((await dns(h, dnsQuery("sharepoint.com", TYPE_A))).rcode).toBe(3);
        expect((await dns(h, dnsQuery("a.b.sharepoint.com", TYPE_A))).rcode).toBe(3);
        expect((await dns(h, dnsQuery("a.sharepoint.com.evil.org", TYPE_A))).rcode).toBe(3);
        expect((await dns(h, dnsQuery("a.sharepoint.com", TYPE_A))).address).toBe("127.0.0.3");
      },
      SLOW,
    );

    test(
      "T on a slot after its name was assigned resolves that name and connects on 443",
      async () => {
        const h = pool();
        await dns(h, dnsQuery("a.sharepoint.com", TYPE_A));
        await relay(h, 1);
        expect(h.resolves).toEqual(["a.sharepoint.com"]);
        expect(h.connects).toEqual([["93.184.216.34", 443]]);
      },
      SLOW,
    );

    test(
      "a slot's name is held to the first-party column, and reported on close",
      async () => {
        const h = pool({ resolve: () => Promise.resolve(["127.0.0.1", "10.0.0.9"]) });
        await dns(h, dnsQuery("a.sharepoint.com", TYPE_A));
        const { c } = await relay(h, 1);
        expect(h.connects).toEqual([["10.0.0.9", 443]]);
        c.socket.terminate();
        await waitFor("the report", () => h.closed.length === 1);
        expect(h.closed[0]?.entry).toEqual({
          ...SLOTS[0],
          host: "a.sharepoint.com",
        } as ForwardEntry);
      },
      SLOW,
    );

    test(
      "T on an unassigned slot closes, and connect is never called",
      async () => {
        const h = pool();
        await dns(h, dnsQuery("a.sharepoint.com", TYPE_A));
        const c = await h.client();
        c.socket.write(tcpHeader(2));
        await waitFor("the close", c.isClosed);
        expect(h.resolves).toEqual([]);
        expect(h.connects).toEqual([]);
      },
      SLOW,
    );

    test(
      "T on a slot whose name no longer matches closes, and connect is never called",
      async () => {
        const wildcards = [WILDCARD];
        const h = pool({ wildcards });
        await dns(h, dnsQuery("a.sharepoint.com", TYPE_A));
        wildcards.length = 0;
        const c = await h.client();
        c.socket.write(tcpHeader(1));
        await waitFor("the close", c.isClosed);
        expect(h.resolves).toEqual([]);
        expect(h.connects).toEqual([]);
      },
      SLOW,
    );

    test(
      "an exact entry that also matches a wildcard is answered from the exact entry",
      async () => {
        const h = pool();
        expect((await dns(h, dnsQuery("tenant.sharepoint.com", TYPE_A))).address).toBe("127.0.0.2");
        expect((await dns(h, dnsQuery("a.sharepoint.com", TYPE_A))).address).toBe("127.0.0.3");
      },
      SLOW,
    );

    test(
      "a name past the pool: SERVFAIL to A and AAAA, one log line, and the rest keep working",
      async () => {
        const entries = Array.from({ length: 48 }, (_, i) => SLOT(`127.0.1.${String(i + 1)}`));
        const h = start({ entries, wildcards: [WILDCARD] });
        for (let i = 0; i < 48; i += 1) {
          const reply = await dns(h, dnsQuery(`n${String(i)}.sharepoint.com`, TYPE_A));
          expect(reply.address).toBe(`127.0.1.${String(i + 1)}`);
        }
        expect(await dns(h, dnsQuery("late.sharepoint.com", TYPE_A))).toEqual({
          rcode: 2,
          address: null,
        });
        expect(await dns(h, dnsQuery("late.sharepoint.com", TYPE_AAAA))).toEqual({
          rcode: 2,
          address: null,
        });
        expect(h.logs).toHaveLength(1);
        expect(h.logs[0]).toContain("late.sharepoint.com");
        expect(h.logs[0]).toContain("wildcard pool full");
        for (let i = 0; i < 48; i += 1) {
          const name = `n${String(i)}.sharepoint.com`;
          expect((await dns(h, dnsQuery(name, TYPE_A))).address).toBe(`127.0.1.${String(i + 1)}`);
          expect(await dns(h, dnsQuery(name, TYPE_AAAA))).toEqual({ rcode: 0, address: null });
        }
        expect(h.logs).toHaveLength(1);
      },
      SLOW,
    );
  });

  describe("the production helpers", () => {
    test(
      "connectTcp relays both ways with half-close, and holds events until handlers are set",
      async () => {
        const seen: string[] = [];
        const server = Bun.listen<null>({
          hostname: "127.0.0.1",
          port: 0,
          allowHalfOpen: true,
          data: null,
          socket: {
            open(s) {
              s.write("greeting");
            },
            data(_s, chunk) {
              seen.push(Buffer.from(chunk).toString());
            },
            end(s) {
              seen.push("<fin>");
              s.write("after-fin");
              s.shutdown();
            },
          },
        });
        try {
          const remote = await connectTcp("127.0.0.1", server.port);
          const got: string[] = [];
          let finished = false;
          await Bun.sleep(20);
          // Once this side has sent its own FIN, Bun reports the far end's FIN as `close` alone.
          remote.setHandlers({
            data: (chunk) => got.push(Buffer.from(chunk).toString()),
            drain: () => undefined,
            end: () => {
              finished = true;
            },
            close: () => {
              finished = true;
            },
          });
          await waitFor("the greeting", () => got.join("") === "greeting");
          expect(remote.write(new TextEncoder().encode("ping"))).toBe(4);
          await waitFor("the write", () => seen.includes("ping"));
          remote.shutdownWrite();
          await waitFor("the far end's FIN", () => finished);
          expect(seen).toContain("<fin>");
          expect(got.join("")).toBe("greetingafter-fin");
          remote.pause();
          remote.resume();
          remote.close();
        } finally {
          server.stop(true);
        }
      },
      SLOW,
    );

    test(
      "connectTcp rejects when nothing listens",
      async () => {
        const server = Bun.listen<null>({
          hostname: "127.0.0.1",
          port: 0,
          data: null,
          socket: { data: () => undefined },
        });
        const port = server.port;
        server.stop(true);
        await expect(connectTcp("127.0.0.1", port)).rejects.toThrow();
      },
      SLOW,
    );

    test(
      "resolveOnHost returns addresses",
      async () => {
        expect(await resolveOnHost("127.0.0.1")).toEqual(["127.0.0.1"]);
      },
      SLOW,
    );

    test(
      "the host relays end to end through connectTcp",
      async () => {
        const server = Bun.listen<null>({
          hostname: "127.0.0.1",
          port: 0,
          allowHalfOpen: true,
          data: null,
          socket: {
            data(s, chunk) {
              s.write(Buffer.from(chunk).toString().toUpperCase());
            },
            end(s) {
              s.shutdown();
            },
          },
        });
        try {
          const h = start({
            entries: [
              { host: "localhost", port: server.port, trust: "owner", loopbackIp: "127.0.0.2" },
            ],
            resolve: () => Promise.resolve(["127.0.0.1"]),
            connect: connectTcp,
          });
          const c = await h.client();
          c.socket.write(tcpHeader(0));
          c.socket.write("shout");
          await waitFor("the echo", () => c.bytes().toString() === "SHOUT");
          c.socket.shutdown();
          await waitFor("the close", () => h.closed.length === 1);
          expect(h.closed[0]?.stats).toMatchObject({ bytesToHost: 5, bytesFromHost: 5 });
        } finally {
          server.stop(true);
        }
      },
      SLOW,
    );
  });
});

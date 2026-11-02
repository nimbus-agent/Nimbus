/** The host probe: fakes for lookup/connect, real sockets only on 127.0.0.1. Nothing leaves the machine. */
import { describe, expect, test } from "bun:test";
import { createServer as createNetServer, type Socket } from "node:net";
import {
  HOST_CONCURRENCY,
  type HostProbeDeps,
  isPublicAddress,
  MAX_HOSTS_PER_RUN,
  probeHost,
  probeHosts,
  REAL_HOST_PROBE,
  TLS_PORTS,
} from "./host-probe.ts";

type ConnectArg = Parameters<HostProbeDeps["connect"]>[0];

function fakeDeps(
  answers: ReadonlyArray<{ address: string; family: 4 | 6 }>,
  connected: ConnectArg[] = [],
): HostProbeDeps {
  return {
    lookup: () => Promise.resolve(answers),
    connect: (o) => {
      connected.push(o);
      return Promise.resolve(true);
    },
  };
}

async function listen(
  onSocket: (s: Socket) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server = createNetServer((s) => {
    sockets.push(s);
    s.on("error", () => {});
    onSocket(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe("isPublicAddress", () => {
  test("true for public addresses", () => {
    for (const a of ["1.1.1.1", "8.8.8.8", "2606:4700::1111"]) {
      expect(isPublicAddress(a)).toBe(true);
    }
  });
  test("false for every blocked range and for garbage", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fc00::1",
      "fe80::1",
      "fe80::1%eth0",
      "fec0::1",
      "ff02::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "2002:a00:1::1",
      "64:ff9b::a00:1",
      "64:ff9b:1::1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "::127.0.0.1",
      "::10.0.0.1",
      "",
      "not-an-ip",
      "1.1.1",
      "1.1.1.1.1",
      "999.1.1.1",
    ];
    for (const a of blocked) expect([a, isPublicAddress(a)]).toEqual([a, false]);
  });
  test("an IPv4-mapped public address is public", () => {
    expect(isPublicAddress("::ffff:1.1.1.1")).toBe(true);
  });
});

describe("probeHost", () => {
  test("a private answer fails without contacting anything", async () => {
    const connected: ConnectArg[] = [];
    const deps = fakeDeps([{ address: "10.0.0.5", family: 4 }], connected);
    expect(await probeHost({ host: "a.example", port: 443 }, deps)).toBe(false);
    expect(connected).toHaveLength(0);
  });
  test("ANY private answer fails the host, even beside a public one", async () => {
    const connected: ConnectArg[] = [];
    const deps = fakeDeps(
      [
        { address: "10.0.0.5", family: 4 },
        { address: "1.1.1.1", family: 4 },
      ],
      connected,
    );
    expect(await probeHost({ host: "a.example", port: 443 }, deps)).toBe(false);
    expect(connected).toHaveLength(0);
  });
  test("all-public answers connect once, to the first", async () => {
    const connected: ConnectArg[] = [];
    const deps = fakeDeps(
      [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
      connected,
    );
    expect(await probeHost({ host: "a.example", port: 443 }, deps)).toBe(true);
    expect(connected).toHaveLength(1);
    expect(connected[0]?.address).toBe("1.1.1.1");
  });
  test("no answers fails", async () => {
    expect(await probeHost({ host: "a.example", port: 443 }, fakeDeps([]))).toBe(false);
  });
  test("TLS ports pass tls true, others false, and servername is the declared host", async () => {
    for (const [port, tls] of [
      [443, true],
      [143, false],
    ] as const) {
      const connected: ConnectArg[] = [];
      await probeHost(
        { host: "mail.example", port },
        fakeDeps([{ address: "1.1.1.1", family: 4 }], connected),
      );
      expect(connected[0]?.tls).toBe(tls);
      expect(connected[0]?.servername).toBe("mail.example");
      expect(connected[0]?.port).toBe(port);
    }
    expect([...TLS_PORTS].sort((a, b) => a - b)).toEqual([443, 465, 636, 853, 993, 995, 8443]);
  });
  test("a rejecting lookup returns false", async () => {
    const deps: HostProbeDeps = {
      lookup: () => Promise.reject(new Error("ENOTFOUND")),
      connect: () => Promise.resolve(true),
    };
    expect(await probeHost({ host: "a.example", port: 443 }, deps)).toBe(false);
  });
  test("a lookup that never resolves returns false within the timeout", async () => {
    const deps: HostProbeDeps = {
      lookup: () => new Promise(() => {}),
      connect: () => Promise.resolve(true),
    };
    const t0 = Date.now();
    expect(await probeHost({ host: "a.example", port: 443 }, deps, { lookupTimeoutMs: 100 })).toBe(
      false,
    );
    expect(Date.now() - t0).toBeLessThan(300);
  });
  test("a throwing connect returns false", async () => {
    const deps: HostProbeDeps = {
      lookup: () => Promise.resolve([{ address: "1.1.1.1", family: 4 }]),
      connect: () => Promise.reject(new Error("boom")),
    };
    expect(await probeHost({ host: "a.example", port: 443 }, deps)).toBe(false);
  });
});

describe("REAL_HOST_PROBE.connect", () => {
  test("a stalled TLS handshake resolves false within the timeout and the socket is closed", async () => {
    let closed: () => void = () => {};
    const sawClose = new Promise<void>((r) => {
      closed = r;
    });
    const srv = await listen((s) => {
      s.on("close", () => closed());
    });
    try {
      const t0 = Date.now();
      const ok = await REAL_HOST_PROBE.connect({
        address: "127.0.0.1",
        family: 4,
        port: srv.port,
        servername: "stalled.example",
        tls: true,
        timeoutMs: 300,
      });
      expect(ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("server never saw the close")), 1000);
      });
      try {
        await Promise.race([sawClose, guard]);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await srv.close();
    }
  });
  test("a plain TCP connect to a listener answers true, sends nothing and closes", async () => {
    let received = 0;
    let closed: () => void = () => {};
    const sawClose = new Promise<void>((r) => {
      closed = r;
    });
    const srv = await listen((s) => {
      s.on("data", (d) => {
        received += d.length;
      });
      s.on("close", () => closed());
    });
    try {
      const ok = await REAL_HOST_PROBE.connect({
        address: "127.0.0.1",
        family: 4,
        port: srv.port,
        servername: "x.example",
        tls: false,
        timeoutMs: 1000,
      });
      expect(ok).toBe(true);
      await sawClose;
      expect(received).toBe(0);
    } finally {
      await srv.close();
    }
  });
  test("a refused connection answers false", async () => {
    const srv = await listen(() => {});
    const port = srv.port;
    await srv.close();
    expect(
      await REAL_HOST_PROBE.connect({
        address: "127.0.0.1",
        family: 4,
        port,
        servername: "x.example",
        tls: false,
        timeoutMs: 1000,
      }),
    ).toBe(false);
  });
  test("probing localhost through the real resolver never contacts the listener", async () => {
    let connections = 0;
    const srv = await listen((s) => {
      connections += 1;
      s.destroy();
    });
    try {
      expect(await probeHost({ host: "localhost", port: srv.port })).toBe(false);
      await new Promise((r) => setTimeout(r, 50));
      expect(connections).toBe(0);
    } finally {
      await srv.close();
    }
  });
});

describe("probeHosts", () => {
  test("caps at 500 lookups, dedupes, and bounds concurrency at 8", async () => {
    let inFlight = 0;
    let peak = 0;
    let lookups = 0;
    const deps: HostProbeDeps = {
      lookup: async () => {
        lookups += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return [{ address: "1.1.1.1", family: 4 }];
      },
      connect: () => Promise.resolve(true),
    };
    const entries = Array.from({ length: 600 }, (_, i) => ({ host: `h${i}.example`, port: 443 }));
    const first = entries[0] as (typeof entries)[number];
    const r = await probeHosts([...entries, first], deps);
    expect(lookups).toBeLessThanOrEqual(MAX_HOSTS_PER_RUN);
    expect(r.declared).toBe(600);
    expect(r.answered).toBe(MAX_HOSTS_PER_RUN);
    expect(peak).toBeLessThanOrEqual(HOST_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
  test("counts answered hosts", async () => {
    const deps: HostProbeDeps = {
      lookup: (h) =>
        Promise.resolve([{ address: h.startsWith("bad") ? "10.0.0.1" : "1.1.1.1", family: 4 }]),
      connect: () => Promise.resolve(true),
    };
    const r = await probeHosts(
      [
        { host: "ok.example", port: 443 },
        { host: "bad.example", port: 443 },
      ],
      deps,
    );
    expect(r).toEqual({ declared: 2, answered: 1 });
  });
});

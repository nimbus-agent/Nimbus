import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type ProbeClient, probeSocketReachable, rawSocketClient } from "./socket-probe.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) {
    rmSync(r, { recursive: true, force: true });
  }
});

/** A fresh socket path: a named pipe on Windows, a unix socket path under the OS temp dir elsewhere. */
function freshSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\nimbus-socket-probe-${randomUUID()}`;
  }
  const root = mkdtempSync(join(tmpdir(), "nimbus-socket-probe-"));
  roots.push(root);
  return join(root, "p.sock");
}

async function listenOn(path: string): Promise<net.Server> {
  const server = net.createServer((sock) => {
    sock.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function fakeClient(
  connect: () => Promise<void>,
  disconnect: () => Promise<void> = async () => undefined,
): ProbeClient & { disconnects: number } {
  const client = {
    disconnects: 0,
    connect,
    disconnect: async () => {
      client.disconnects += 1;
      await disconnect();
    },
  };
  return client;
}

describe("probeSocketReachable", () => {
  test("a connect that resolves is reachable, and the client is disconnected", async () => {
    const client = fakeClient(async () => undefined);
    expect(await probeSocketReachable(client, 1000)).toBe(true);
    expect(client.disconnects).toBe(1);
  });

  test("a connect that rejects is unreachable, and the client is disconnected", async () => {
    const client = fakeClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeSocketReachable(client, 1000)).toBe(false);
    expect(client.disconnects).toBe(1);
  });

  test("a connect that never settles is unreachable once the timeout elapses", async () => {
    const client = fakeClient(() => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await probeSocketReachable(client, 20)).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(client.disconnects).toBe(1);
  });

  test("a disconnect that rejects does not change a reachable answer", async () => {
    const client = fakeClient(
      async () => undefined,
      async () => {
        throw new Error("disconnect failed");
      },
    );
    expect(await probeSocketReachable(client, 1000)).toBe(true);
  });

  test("a disconnect that rejects does not change an unreachable answer", async () => {
    const client = fakeClient(
      async () => {
        throw new Error("ECONNREFUSED");
      },
      async () => {
        throw new Error("disconnect failed");
      },
    );
    expect(await probeSocketReachable(client, 1000)).toBe(false);
  });
});

describe("rawSocketClient", () => {
  test("disconnect() before connect() does not throw", async () => {
    await expect(rawSocketClient(freshSocketPath()).disconnect()).resolves.toBeUndefined();
  });

  test("connects to a real listener", async () => {
    const path = freshSocketPath();
    const server = await listenOn(path);
    const client = rawSocketClient(path);
    try {
      await expect(client.connect()).resolves.toBeUndefined();
      expect(await probeSocketReachable(rawSocketClient(path), 2000)).toBe(true);
    } finally {
      await client.disconnect();
      await closeServer(server);
    }
  });

  test("rejects against a path nobody listens on", async () => {
    const client = rawSocketClient(freshSocketPath());
    try {
      await expect(client.connect()).rejects.toThrow();
    } finally {
      await client.disconnect();
    }
  });
});

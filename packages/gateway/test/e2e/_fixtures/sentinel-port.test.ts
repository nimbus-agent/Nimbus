import { expect, test } from "bun:test";
import net from "node:net";

import { pickSentinelPort, SENTINEL_PORT_RANGE } from "./sentinel-port.ts";

function listenOnZero(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ port, close: () => new Promise<void>((r) => s.close(() => r())) });
    });
  });
}

test("a sentinel port is inside the range and bindable when picked", async () => {
  const port = await pickSentinelPort();
  expect(port).toBeGreaterThanOrEqual(SENTINEL_PORT_RANGE.low);
  expect(port).toBeLessThan(SENTINEL_PORT_RANGE.high);
});

test("premise: this OS hands out listen(0) ports OUTSIDE the sentinel range", async () => {
  // The whole point of the range. If an OS or a runner image ever moved its ephemeral range down
  // here, the picker would silently regain the collision it exists to remove — fail instead.
  const servers = await Promise.all(Array.from({ length: 64 }, () => listenOnZero()));
  try {
    for (const s of servers) {
      const inside = s.port >= SENTINEL_PORT_RANGE.low && s.port < SENTINEL_PORT_RANGE.high;
      expect(inside).toBe(false);
    }
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
});

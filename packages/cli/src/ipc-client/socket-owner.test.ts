import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IPCClient } from "./index.ts";
import { assertSocketOwnedByCurrentUser, ForeignSocketOwnerError } from "./socket-owner.ts";

const socketStat = (uid: number) => () => ({ uid, isSocket: () => true });

describe("assertSocketOwnedByCurrentUser (audit S4)", () => {
  test("refuses a socket another uid owns, naming the remedy and never connecting", () => {
    expect(() =>
      assertSocketOwnedByCurrentUser("/tmp/nimbus-gateway.sock", {
        platform: "linux",
        getuid: () => 1000,
        lstat: socketStat(1001),
      }),
    ).toThrow(ForeignSocketOwnerError);
    try {
      assertSocketOwnedByCurrentUser("/tmp/nimbus-gateway.sock", {
        platform: "linux",
        getuid: () => 1000,
        lstat: socketStat(1001),
      });
    } catch (e) {
      expect(String(e)).toContain("ERR_GATEWAY_SOCKET_FOREIGN_OWNER");
      expect(String(e)).toContain("XDG_RUNTIME_DIR");
    }
  });

  test("accepts our own socket, a missing path, a non-socket, and Windows", () => {
    const deps = { platform: "linux" as const, getuid: () => 1000 };
    expect(() =>
      assertSocketOwnedByCurrentUser("/s", { ...deps, lstat: socketStat(1000) }),
    ).not.toThrow();
    expect(() =>
      assertSocketOwnedByCurrentUser("/s", {
        ...deps,
        lstat: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertSocketOwnedByCurrentUser("/s", {
        ...deps,
        lstat: () => ({ uid: 1001, isSocket: () => false }),
      }),
    ).not.toThrow();
    expect(() =>
      assertSocketOwnedByCurrentUser(String.raw`\\.\pipe\nimbus-gateway`, {
        platform: "win32",
        getuid: () => 1000,
        lstat: socketStat(1001),
      }),
    ).not.toThrow();
  });

  test.skipIf(process.platform === "win32")(
    "a real socket this process created passes",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-sock-owner-"));
      const path = join(dir, "g.sock");
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(path, resolve));
      try {
        expect(() => assertSocketOwnedByCurrentUser(path)).not.toThrow();
        writeFileSync(join(dir, "plain"), "x");
        expect(() => assertSocketOwnedByCurrentUser(join(dir, "plain"))).not.toThrow();
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("through the CLI client, a missing socket still fails the ordinary way", async () => {
    const client = new IPCClient(join(tmpdir(), "nimbus-no-such-gateway.sock"));
    // A missing socket is not refused by the owner check; the connect itself fails as before.
    await expect(client.connect()).rejects.not.toBeInstanceOf(ForeignSocketOwnerError);
  });
});

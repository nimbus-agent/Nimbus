import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

import type { ClientSession, SessionWrite } from "../session.ts";
import {
  chmodListenSocketBestEffort,
  removeStaleUnixSocketIfPresent,
  startBunUnixListener,
  startWin32NetServer,
} from "./socket-listeners.ts";

type StubState = {
  pushed: Uint8Array[];
  endedInput: boolean;
  disposed: boolean;
  writes: string[];
};

function makeStubState(): StubState {
  return { pushed: [], endedInput: false, disposed: false, writes: [] };
}

function makeStubSession(state: StubState, write: SessionWrite): ClientSession {
  return {
    push: (data: Uint8Array) => {
      state.pushed.push(data);
    },
    endInput: () => {
      state.endedInput = true;
    },
    dispose: () => {
      state.disposed = true;
    },
    writeNotification: () => {
      /* unused */
    },
    _write: write,
  } as unknown as ClientSession;
}

describe("removeStaleUnixSocketIfPresent", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-stale-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("is a no-op when path does not exist", () => {
    const p = join(tmpDir, "nope.sock");
    expect(existsSync(p)).toBe(false);
    expect(() => removeStaleUnixSocketIfPresent(p)).not.toThrow();
    expect(existsSync(p)).toBe(false);
  });

  test("unlinks a stale regular file at the listen path", () => {
    const p = join(tmpDir, "stale.sock");
    writeFileSync(p, "x");
    expect(existsSync(p)).toBe(true);
    removeStaleUnixSocketIfPresent(p);
    expect(existsSync(p)).toBe(false);
  });

  test("swallows unlink errors silently (path is a directory => EISDIR/EPERM)", () => {
    const dirPath = join(tmpDir, "dir-as-socket");
    mkdirSync(dirPath);
    expect(existsSync(dirPath)).toBe(true);
    expect(() => removeStaleUnixSocketIfPresent(dirPath)).not.toThrow();
    expect(existsSync(dirPath)).toBe(true);
  });
});

describe("chmodListenSocketBestEffort", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-sock-chmod-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("chmods an existing file to 0o600 without throwing", () => {
    const p = join(tmpDir, "perm.sock");
    writeFileSync(p, "x");
    expect(() => chmodListenSocketBestEffort(p)).not.toThrow();
  });

  test("swallows errors when the path does not exist", () => {
    const p = join(tmpDir, "missing.sock");
    expect(existsSync(p)).toBe(false);
    expect(() => chmodListenSocketBestEffort(p)).not.toThrow();
  });
});

describe("startWin32NetServer (cross-platform via unix socket on POSIX)", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    if (platform() === "win32") return;
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-win32-"));
    socketPath = join(tmpDir, "g.sock");
  });

  afterEach(() => {
    if (platform() === "win32") return;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test.skipIf(platform() === "win32")(
    "starts a net.createServer at the listen path; winSockets starts empty",
    async () => {
      const state = makeStubState();
      const stubSession = makeStubSession(state, () => {});
      const attach = (_write: SessionWrite): ClientSession => stubSession;

      const handle = await startWin32NetServer(socketPath, attach);
      try {
        expect(handle.netServer).toBeDefined();
        expect(handle.netServer.listening).toBe(true);
        expect(handle.winSockets.size).toBe(0);
      } finally {
        await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
      }
    },
  );

  test.skipIf(platform() === "win32")(
    "client connect/write/end/close drives push/endInput/dispose and winSockets cleanup",
    async () => {
      const state = makeStubState();
      let capturedWrite: SessionWrite | null = null;
      const attach = (write: SessionWrite): ClientSession => {
        capturedWrite = write;
        return makeStubSession(state, write);
      };

      const handle = await startWin32NetServer(socketPath, attach);
      try {
        await new Promise<void>((resolve, reject) => {
          const client = net.connect(socketPath, () => {
            client.write(Buffer.from([0x41, 0x42, 0x43]));
            client.end();
          });
          client.on("close", () => resolve());
          client.on("error", reject);
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        expect(capturedWrite).not.toBeNull();

        expect(state.pushed.length).toBeGreaterThanOrEqual(1);
        const total = state.pushed.reduce((acc, u) => acc + u.byteLength, 0);
        expect(total).toBe(3);
        expect(state.pushed[0]?.[0]).toBe(0x41);

        expect(state.endedInput).toBe(true);
        expect(state.disposed).toBe(true);

        expect(handle.winSockets.size).toBe(0);
      } finally {
        await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
      }
    },
  );

  test.skipIf(platform() === "win32")(
    "socket 'error' handler removes the socket from winSockets and disposes the session",
    async () => {
      const state = makeStubState();
      const stubSession = makeStubSession(state, () => {});
      const attach = (_write: SessionWrite): ClientSession => stubSession;

      const handle = await startWin32NetServer(socketPath, attach);
      try {
        const client = net.connect(socketPath);
        await new Promise<void>((resolve, reject) => {
          client.on("connect", () => resolve());
          client.on("error", reject);
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        expect(handle.winSockets.size).toBe(1);

        const serverSock = Array.from(handle.winSockets)[0];
        expect(serverSock).toBeDefined();
        serverSock?.destroy(new Error("forced-error-for-coverage"));

        client.on("error", () => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        expect(handle.winSockets.size).toBe(0);
        expect(state.disposed).toBe(true);

        try {
          client.destroy();
        } catch {
          /* best-effort */
        }
      } finally {
        await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
      }
    },
  );
});

describe("startWin32NetServer post-listen faults", () => {
  const paths: string[] = [];
  let tmpDir: string | undefined;

  // Runs on EVERY platform: the win32 path is the one that regressed, so it must not be skipped
  // on the only OS where it is the production code path.
  function listenPath(): string {
    if (platform() === "win32") {
      const p = `\\\\.\\pipe\\nimbus-fault-${crypto.randomUUID()}`;
      paths.push(p);
      return p;
    }
    tmpDir ??= mkdtempSync(join(tmpdir(), "nimbus-fault-"));
    return join(tmpDir, `${crypto.randomUUID()}.sock`);
  }

  afterEach(() => {
    if (tmpDir !== undefined) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      tmpDir = undefined;
    }
  });

  const attach = (): ClientSession => makeStubSession(makeStubState(), () => {});

  test("an 'error' emitted AFTER listen reaches onFault instead of being swallowed", async () => {
    // Regression: the startup listener used to stay attached, so every later error was a call to
    // an already-resolved reject() — a no-op that still registered as an 'error' handler.
    const faults: Array<{ event: string; message?: string }> = [];
    const handle = await startWin32NetServer(listenPath(), attach, (f) => {
      faults.push({
        event: f.event,
        ...(f.error === undefined ? {} : { message: f.error.message }),
      });
    });
    try {
      handle.netServer.emit("error", new Error("pipe went away"));
      expect(faults).toEqual([{ event: "error", message: "pipe went away" }]);
    } finally {
      handle.markExpectedClose();
      await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
    }
  });

  test("an unrequested 'close' is reported as a fault", async () => {
    const faults: string[] = [];
    const handle = await startWin32NetServer(listenPath(), attach, (f) => faults.push(f.event));
    await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
    expect(faults).toEqual(["close"]);
  });

  test("markExpectedClose() suppresses the fault for a deliberate stop()", async () => {
    const faults: string[] = [];
    const handle = await startWin32NetServer(listenPath(), attach, (f) => faults.push(f.event));
    handle.markExpectedClose();
    await new Promise<void>((resolve) => handle.netServer.close(() => resolve()));
    expect(faults).toEqual([]);
  });

  test("a bind failure still rejects start() (the startup listener is not lost)", async () => {
    const p = listenPath();
    const first = await startWin32NetServer(p, attach);
    try {
      await expect(startWin32NetServer(p, attach)).rejects.toThrow();
    } finally {
      first.markExpectedClose();
      await new Promise<void>((resolve) => first.netServer.close(() => resolve()));
    }
  });
});

describe("startBunUnixListener (POSIX-only)", () => {
  let tmpDir: string;
  let socketPath: string;

  beforeEach(() => {
    if (platform() === "win32") return;
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-bunlsn-"));
    socketPath = join(tmpDir, "g.sock");
  });

  afterEach(() => {
    if (platform() === "win32") return;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test.skipIf(platform() === "win32")(
    "accepts a connection and routes bytes through session.push, then close fires endInput + dispose",
    async () => {
      const state = makeStubState();
      let capturedWrite: SessionWrite | null = null;
      const attach = (write: SessionWrite): ClientSession => {
        capturedWrite = write;
        return makeStubSession(state, write);
      };

      const listener = startBunUnixListener(socketPath, attach);
      try {
        await new Promise<void>((resolve, reject) => {
          const client = net.connect(socketPath, () => {
            client.write(Buffer.from([0x42]));
            client.end();
          });
          client.on("close", () => resolve());
          client.on("error", reject);
        });

        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        expect(capturedWrite).not.toBeNull();
        expect(state.pushed.length).toBeGreaterThan(0);
        expect(state.pushed[0]?.[0]).toBe(0x42);
        expect(state.endedInput).toBe(true);
        expect(state.disposed).toBe(true);
      } finally {
        try {
          listener.stop();
        } catch {
          /* best-effort */
        }
      }
    },
  );
});

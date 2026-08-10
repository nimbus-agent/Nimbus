import type { EventEmitter } from "node:events";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import net from "node:net";

import type { ClientSession, SessionWrite } from "../session.ts";
import type { BunSessionData } from "./options.ts";

export function removeStaleUnixSocketIfPresent(listenPath: string): void {
  if (!existsSync(listenPath)) {
    return;
  }
  try {
    unlinkSync(listenPath);
  } catch {
    /* stale or race — bind will surface EADDRINUSE */
  }
}

export function chmodListenSocketBestEffort(listenPath: string): void {
  try {
    chmodSync(listenPath, 0o600);
  } catch {
    /* best-effort — platform-specific */
  }
}

export type AttachSessionFn = (write: SessionWrite) => ClientSession;

export type Win32ListenerHandle = {
  netServer: net.Server;
  winSockets: Set<net.Socket>;
  /** Call before a deliberate `close()` so the resulting 'close' is not reported as a fault. */
  markExpectedClose: () => void;
};

function attachWin32Socket(
  attachSession: AttachSessionFn,
  winSockets: Set<net.Socket>,
  sock: net.Socket,
): void {
  winSockets.add(sock);
  const session = attachSession((line) => {
    sock.write(line);
  });
  sock.on("data", (buf: Buffer) => {
    session.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  });
  sock.on("end", () => {
    session.endInput();
  });
  sock.on("close", () => {
    winSockets.delete(sock);
    session.dispose();
  });
  sock.on("error", () => {
    winSockets.delete(sock);
    session.dispose();
  });
}

/** A named-pipe server fault that happens AFTER the listen succeeded. */
export type Win32ServerFault = { readonly event: "error" | "close"; readonly error?: Error };

export async function startWin32NetServer(
  listenPath: string,
  attachSession: AttachSessionFn,
  onFault?: (fault: Win32ServerFault) => void,
): Promise<Win32ListenerHandle> {
  const winSockets = new Set<net.Socket>();
  const netServer = await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((sock) => attachWin32Socket(attachSession, winSockets, sock));
    const emitter = server as unknown as EventEmitter;
    // Scoped to the bind: this listener exists only to fail `start()`. Leaving it attached after
    // the promise settles made every LATER pipe error a call to an already-resolved `reject` —
    // a silent no-op that still counted as an 'error' handler, so the fault vanished entirely.
    const onStartupError = (err: Error): void => {
      reject(err);
    };
    emitter.once("error", onStartupError);
    server.listen(listenPath, () => {
      emitter.off("error", onStartupError);
      resolve(server);
    });
  });

  // A live pipe server is what the gateway's whole IPC surface rests on; if it errors or closes
  // out from under us, clients see ENOENT with nothing in the log to say why.
  let expectedClose = false;
  const emitter = netServer as unknown as EventEmitter;
  emitter.on("error", (err: Error) => {
    onFault?.({ event: "error", error: err });
  });
  emitter.on("close", () => {
    // `stop()` closes the server on purpose; only an unrequested close is a fault.
    if (!expectedClose) {
      onFault?.({ event: "close" });
    }
  });
  return {
    netServer,
    winSockets,
    markExpectedClose: (): void => {
      expectedClose = true;
    },
  };
}

export function startBunUnixListener(
  listenPath: string,
  attachSession: AttachSessionFn,
): ReturnType<typeof Bun.listen<BunSessionData>> {
  return Bun.listen<BunSessionData>({
    unix: listenPath,
    socket: {
      open(socket) {
        const session = attachSession((line) => {
          socket.write(line);
        });
        socket.data = { session };
      },
      data(socket, data: Uint8Array) {
        socket.data.session.push(data);
      },
      close(socket) {
        const s = socket.data.session;
        s.endInput();
        s.dispose();
      },
      error(socket) {
        socket.data.session?.dispose();
      },
    },
  });
}

import { describe, expect, test } from "bun:test";
import { bunSocketFactory } from "./bun-socket.ts";

describe("bunSocketFactory (SocketLike over a real WebSocket)", () => {
  test("round-trips messages and surfaces close", async () => {
    const received: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("not ws", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.send("hello-from-server");
        },
        message(ws, message) {
          received.push(String(message));
          ws.close();
        },
      },
    });
    try {
      const sock = bunSocketFactory(`ws://127.0.0.1:${server.port}`);
      const got: string[] = [];
      let closed = false;
      sock.onMessage((raw) => got.push(raw));
      sock.onClose(() => {
        closed = true;
      });
      const start = Date.now();
      while (got.length === 0) {
        if (Date.now() - start > 3000) throw new Error("no server hello");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(got).toEqual(["hello-from-server"]);
      sock.send("hi-back");
      while (!closed) {
        if (Date.now() - start > 3000) throw new Error("no close");
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(received).toEqual(["hi-back"]);
      sock.close(); // idempotent after server close
    } finally {
      server.stop(true);
    }
  });
});

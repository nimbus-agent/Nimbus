import type { SocketLike } from "./slack-socket-adapter.ts";

/** Production `socketFactory` for the Slack Socket Mode adapter: a thin SocketLike over the
 *  runtime WebSocket (Bun implements the WHATWG WebSocket API). */
export function bunSocketFactory(url: string): SocketLike {
  const ws = new WebSocket(url);
  return {
    onMessage(cb: (raw: string) => void): void {
      ws.addEventListener("message", (ev: MessageEvent) => {
        cb(typeof ev.data === "string" ? ev.data : String(ev.data));
      });
    },
    onClose(cb: () => void): void {
      ws.addEventListener("close", () => cb());
    },
    send(raw: string): void {
      ws.send(raw);
    },
    close(): void {
      ws.close();
    },
  };
}

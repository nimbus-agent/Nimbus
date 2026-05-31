/**
 * JSON-RPC 2.0 IPC client — Unix socket or Windows named pipe.
 * @see architecture.md §IPC Protocol
 */

import { randomUUID } from "node:crypto";
import net from "node:net";
import { platform } from "node:os";

import { NdjsonLineReader } from "@nimbus-dev/sdk/ipc";

const HAS_BUN = (globalThis as { Bun?: unknown }).Bun !== undefined;

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

function idKey(id: string | number): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

function jsonRpcErrorMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) {
    return "JSON-RPC error";
  }
  if (!("message" in err)) {
    return "JSON-RPC error";
  }
  const msg = err.message;
  if (typeof msg !== "string") {
    return "JSON-RPC error";
  }
  return msg;
}

function tryParseJsonRecord(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export class IPCClient {
  private readonly socketPath: string;
  private reader = new NdjsonLineReader();
  private readonly pending = new Map<string, Pending>();
  private readonly notifHandlers = new Map<string, Set<(params: unknown) => void>>();
  private bunSocket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
  private netSocket: net.Socket | null = null;
  private connected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.reader = new NdjsonLineReader();

    if (platform() === "win32") {
      await this.connectWindows();
      return;
    }

    await this.connectUnix();
  }

  private async connectWindows(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      this.attachNetSocket(sock, resolve, reject);
    });
  }

  private attachNetSocket(sock: net.Socket, resolve: () => void, reject: (e: Error) => void): void {
    sock.on("connect", () => {
      this.netSocket = sock;
      this.connected = true;
      resolve();
    });
    sock.on("error", (err) => {
      reject(err);
    });
    sock.on("data", (buf: Buffer) => {
      this.onTransportData(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    sock.on("close", () => {
      this.onNetSocketClosed();
    });
  }

  private async connectUnix(): Promise<void> {
    if (HAS_BUN) {
      await this.connectUnixBun();
      return;
    }
    await this.connectUnixNode();
  }

  private async connectUnixBun(): Promise<void> {
    this.bunSocket = await Bun.connect({
      unix: this.socketPath,
      socket: {
        data: (_socket, chunk: Uint8Array) => {
          this.onTransportData(chunk);
        },
        close: () => {
          this.onUnixClosed(new Error("IPC connection closed"));
        },
        error: () => {
          this.onUnixClosed(new Error("IPC connection error"));
        },
      },
    });
    this.connected = true;
  }

  private async connectUnixNode(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ path: this.socketPath });
      this.attachNetSocket(sock, resolve, reject);
    });
  }

  private onTransportData(chunk: Uint8Array): void {
    try {
      this.ingest(chunk);
    } catch (e) {
      this.failAll(e);
    }
  }

  private onNetSocketClosed(): void {
    this.connected = false;
    this.netSocket = null;
    this.failAll(new Error("IPC connection closed"));
  }

  private onUnixClosed(err: Error): void {
    this.connected = false;
    this.bunSocket = null;
    this.failAll(err);
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    if (!this.connected) {
      throw new Error("IPC client is not connected");
    }
    const id = randomUUID();
    const body: { jsonrpc: string; id: string; method: string; params?: unknown } = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      body.params = params;
    }
    const line = `${JSON.stringify(body)}\n`;

    return await new Promise<T>((resolve, reject) => {
      this.pending.set(idKey(id), {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.rawWrite(line);
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    let set = this.notifHandlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.notifHandlers.set(method, set);
    }
    set.add(handler);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.failAll(new Error("IPC disconnected"));
    this.endWindowsTransport();
    this.endUnixTransport();
  }

  private endWindowsTransport(): void {
    if (this.netSocket === null) {
      return;
    }
    this.netSocket.end();
    this.netSocket = null;
  }

  private endUnixTransport(): void {
    if (this.bunSocket === null) {
      return;
    }
    this.bunSocket.end();
    this.bunSocket = null;
  }

  private rawWrite(s: string): void {
    if (this.netSocket !== null) {
      this.netSocket.write(s);
      return;
    }
    if (this.bunSocket !== null) {
      this.bunSocket.write(s);
    }
  }

  private ingest(chunk: Uint8Array): void {
    const lines = this.reader.push(chunk);
    for (const line of lines) {
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    const o = tryParseJsonRecord(line);
    if (o === undefined) {
      return;
    }
    if (o["jsonrpc"] !== "2.0") {
      return;
    }
    if (Object.hasOwn(o, "id")) {
      this.dispatchRpcLine(o);
      return;
    }
    this.dispatchNotificationLine(o);
  }

  private dispatchRpcLine(o: Record<string, unknown>): void {
    const id = o["id"];
    if (typeof id !== "string" && typeof id !== "number") {
      return;
    }
    const pend = this.pending.get(idKey(id));
    if (pend === undefined) {
      return;
    }
    this.pending.delete(idKey(id));
    if (Object.hasOwn(o, "error")) {
      pend.reject(new Error(jsonRpcErrorMessage(o["error"])));
      return;
    }
    pend.resolve(Object.hasOwn(o, "result") ? o["result"] : undefined);
  }

  private dispatchNotificationLine(o: Record<string, unknown>): void {
    if (typeof o["method"] !== "string") {
      return;
    }
    const params = Object.hasOwn(o, "params") ? o["params"] : undefined;
    const set = this.notifHandlers.get(o["method"]);
    if (set === undefined) {
      return;
    }
    for (const h of set) {
      h(params);
    }
  }

  private failAll(reason: unknown): void {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    if (this.pending.size === 0) {
      return;
    }
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
  }
}

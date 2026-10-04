import {
  encodeLine,
  errorResponse,
  type JsonRpcNotification,
  type JsonRpcOutbound,
  JsonRpcParseError,
  type JsonRpcRequest,
  NdjsonLineReader,
  parseJsonRpcLine,
} from "./jsonrpc.ts";

export type SessionWrite = (line: string) => void;

export class ClientSession {
  readonly clientId: string;
  private readonly reader = new NdjsonLineReader();
  private readonly write: SessionWrite;
  private readonly onRpc: (
    clientId: string,
    msg: JsonRpcRequest | JsonRpcNotification,
  ) => void | Promise<void>;
  private readonly onDispose: (clientId: string) => void;
  private disposed = false;

  constructor(
    clientId: string,
    write: SessionWrite,
    onRpc: (clientId: string, msg: JsonRpcRequest | JsonRpcNotification) => void | Promise<void>,
    onDispose: (clientId: string) => void,
  ) {
    this.clientId = clientId;
    this.write = write;
    this.onRpc = onRpc;
    this.onDispose = onDispose;
  }

  push(chunk: Uint8Array): void {
    if (this.disposed) {
      return;
    }
    let lines: string[];
    try {
      lines = this.reader.push(chunk);
    } catch (e) {
      this.sendParseFailure(e);
      return;
    }
    void this.dispatchLines(lines).catch((e: unknown) => {
      const m = e instanceof Error ? e.message : "dispatch error";
      this.write(encodeLine(errorResponse(null, -32603, m)));
      this.dispose();
    });
  }

  endInput(): void {
    if (this.disposed) {
      return;
    }
    let lines: string[];
    try {
      lines = this.reader.flush();
    } catch (e) {
      this.sendParseFailure(e);
      return;
    }
    void this.dispatchLines(lines).catch((e: unknown) => {
      const m = e instanceof Error ? e.message : "dispatch error";
      this.write(encodeLine(errorResponse(null, -32603, m)));
      this.dispose();
    });
  }

  writeOutbound(msg: JsonRpcOutbound): void {
    if (this.disposed) {
      return;
    }
    this.write(encodeLine(msg));
  }

  writeNotification(n: JsonRpcNotification): void {
    this.writeOutbound(n);
  }

  private sendParseFailure(e: unknown): void {
    const msg = e instanceof JsonRpcParseError ? e.message : "Parse error";
    this.write(encodeLine(errorResponse(null, -32700, msg)));
    this.dispose();
  }

  private async dispatchLines(lines: string[]): Promise<void> {
    for (const line of lines) {
      let msg: JsonRpcRequest | JsonRpcNotification;
      try {
        msg = parseJsonRpcLine(line);
      } catch (e) {
        const m = e instanceof JsonRpcParseError ? e.message : "Parse error";
        this.writeOutbound(errorResponse(null, -32700, m));
        continue;
      }
      try {
        await this.onRpc(this.clientId, msg); // NOSONAR S9382: sequential by design - a client's pipelined messages are handled in arrival order, so each sees the effects (vault/DB writes) of the ones before it
      } catch (e) {
        try {
          const m = e instanceof Error ? e.message : "Internal error";
          this.writeOutbound(errorResponse(null, -32603, m));
        } catch {
          this.dispose();
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.onDispose(this.clientId);
  }
}

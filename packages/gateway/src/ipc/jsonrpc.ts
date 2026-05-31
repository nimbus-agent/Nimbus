import { NdjsonLineReader as SdkNdjsonLineReader } from "@nimbus-dev/sdk/ipc";

export { IPC_MAX_LINE_BYTES } from "@nimbus-dev/sdk/ipc";

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
  id: JsonRpcId;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcOutbound = JsonRpcSuccess | JsonRpcErrorResponse | JsonRpcNotification;

export function encodeLine(message: JsonRpcOutbound): string {
  return `${JSON.stringify(message)}\n`;
}

export class JsonRpcParseError extends Error {
  override readonly name = "JsonRpcParseError";
}

export class NdjsonLineReader {
  private readonly inner: SdkNdjsonLineReader;

  constructor() {
    this.inner = new SdkNdjsonLineReader({ lineLimitError: JsonRpcParseError });
  }

  push(chunk: Uint8Array): string[] {
    return this.inner.push(chunk);
  }

  flush(): string[] {
    return this.inner.flush();
  }
}

export function parseJsonRpcLine(line: string): JsonRpcRequest | JsonRpcNotification {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new JsonRpcParseError("Invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new JsonRpcParseError("JSON-RPC payload must be an object");
  }
  const o = parsed as Record<string, unknown>;
  if (o["jsonrpc"] !== "2.0") {
    throw new JsonRpcParseError('Invalid or missing jsonrpc "2.0" field');
  }
  if (typeof o["method"] !== "string" || o["method"].length === 0) {
    throw new JsonRpcParseError("Invalid or missing method");
  }
  const hasId = Object.hasOwn(o, "id");
  if (hasId) {
    const id = o["id"];
    if (id !== null && typeof id !== "string" && typeof id !== "number") {
      throw new JsonRpcParseError("Invalid id");
    }
    return {
      jsonrpc: "2.0",
      method: o["method"],
      ...(Object.hasOwn(o, "params") ? { params: o["params"] } : {}),
      id,
    };
  }
  return {
    jsonrpc: "2.0",
    method: o["method"],
    ...(Object.hasOwn(o, "params") ? { params: o["params"] } : {}),
  };
}

export function isRequest(msg: JsonRpcRequest | JsonRpcNotification): msg is JsonRpcRequest {
  return Object.hasOwn(msg, "id");
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

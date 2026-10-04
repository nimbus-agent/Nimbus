import { describe, expect, test } from "bun:test";
import { errorResponse, isRequest, JsonRpcParseError, parseJsonRpcLine } from "./jsonrpc.ts";

/**
 * `parseJsonRpcLine` is the first thing every IPC line meets, so each refusal must name ITS cause:
 * the session maps a `JsonRpcParseError` straight to a -32700 reply carrying this message, and a
 * client debugging a bad request reads nothing else. `ipc.test.ts` covers the accepting shapes.
 */

function parseErrorOf(line: string): JsonRpcParseError {
  try {
    parseJsonRpcLine(line);
  } catch (e) {
    if (e instanceof JsonRpcParseError) return e;
    throw e;
  }
  throw new Error(`expected ${line} to be refused`);
}

describe("parseJsonRpcLine — refusals", () => {
  test("text that is not JSON is 'Invalid JSON'", () => {
    expect(parseErrorOf("{not json").message).toBe("Invalid JSON");
  });

  for (const line of [
    "null",
    "[]",
    '[{"jsonrpc":"2.0","method":"gateway.ping","id":1}]',
    "42",
    '"x"',
  ]) {
    test(`a payload that is not an object (${line}) is refused as such`, () => {
      const err = parseErrorOf(line);
      expect(err.message).toBe("JSON-RPC payload must be an object");
      expect(err.name).toBe("JsonRpcParseError");
    });
  }

  for (const line of [
    '{"jsonrpc":"2.0","id":1}',
    '{"jsonrpc":"2.0","method":"","id":1}',
    '{"jsonrpc":"2.0","method":7,"id":1}',
  ]) {
    test(`a missing, empty or non-string method is 'Invalid or missing method': ${line}`, () => {
      expect(parseErrorOf(line).message).toBe("Invalid or missing method");
    });
  }

  for (const id of ["{}", "[1]", "true"]) {
    test(`an id that is not a string, number or null (${id}) is 'Invalid id'`, () => {
      const line = `{"jsonrpc":"2.0","method":"gateway.ping","id":${id}}`;
      expect(parseErrorOf(line).message).toBe("Invalid id");
    });
  }

  test("the jsonrpc version is checked before the method", () => {
    expect(parseErrorOf('{"jsonrpc":"1.0"}').message).toBe(
      'Invalid or missing jsonrpc "2.0" field',
    );
  });
});

describe("parseJsonRpcLine — accepted shapes", () => {
  test("a null id is a request, and absent params stay absent", () => {
    const msg = parseJsonRpcLine('{"jsonrpc":"2.0","method":"gateway.ping","id":null}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "gateway.ping", id: null });
    expect(isRequest(msg)).toBe(true);
    expect("params" in msg).toBe(false);
  });

  test("a notification without params carries no params key", () => {
    const msg = parseJsonRpcLine('{"jsonrpc":"2.0","method":"consent.respond"}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "consent.respond" });
    expect(isRequest(msg)).toBe(false);
  });

  test("explicit null params are preserved on a request", () => {
    const msg = parseJsonRpcLine('{"jsonrpc":"2.0","method":"m","params":null,"id":"r1"}');
    expect(msg).toEqual({ jsonrpc: "2.0", method: "m", params: null, id: "r1" });
  });
});

describe("errorResponse", () => {
  test("omits data unless given, and carries it verbatim when it is", () => {
    const bare = errorResponse(3, -32601, "Method not found");
    expect(bare).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    });
    // `toEqual` ignores an undefined-valued key, so the absence is asserted on its own.
    expect("data" in bare.error).toBe(false);
    expect(errorResponse(null, -32602, "bad", { field: "x" })).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32602, message: "bad", data: { field: "x" } },
    });
  });
});

import { describe, expect, test } from "bun:test";
import { parseShareCreateArgs } from "./share.ts";

describe("parseShareCreateArgs", () => {
  test("parses session id, sink, expiry, redact patterns", () => {
    const r = parseShareCreateArgs([
      "s-123",
      "--out",
      "x.json",
      "--expires",
      "7d",
      "--redact",
      "ZURICH",
    ]);
    expect(r.sessionId).toBe("s-123");
    expect(r.sink).toEqual({ type: "file", path: "x.json" });
    expect(r.expiresMs).toBeGreaterThan(0);
    expect(r.redact).toEqual(["ZURICH"]);
  });

  test("defaults sink to a file when none given", () => {
    expect(parseShareCreateArgs(["s-1"]).sink.type).toBe("file");
  });

  test("selects the http sink with --http", () => {
    expect(parseShareCreateArgs(["s-1", "--http"]).sink).toEqual({ type: "http" });
  });

  test("selects the peer sink with --to-peer", () => {
    expect(parseShareCreateArgs(["s-1", "--to-peer", "peer-7"]).sink).toEqual({
      type: "peer",
      peerId: "peer-7",
    });
  });

  test("collects multiple --redact patterns and flags --as-recipe", () => {
    const r = parseShareCreateArgs(["s-1", "--redact", "A", "--redact", "B", "--as-recipe"]);
    expect(r.redact).toEqual(["A", "B"]);
    expect(r.asRecipe).toBe(true);
  });

  test("null expiry when --expires is absent or malformed", () => {
    expect(parseShareCreateArgs(["s-1"]).expiresMs).toBeNull();
    expect(parseShareCreateArgs(["s-1", "--expires", "nope"]).expiresMs).toBeNull();
  });

  test("rejects an option whose value is missing or is another flag", () => {
    expect(() => parseShareCreateArgs(["s-1", "--out"])).toThrow(/--out requires a value/);
    expect(() => parseShareCreateArgs(["s-1", "--out", "--http"])).toThrow(
      /--out requires a value/,
    );
    expect(() => parseShareCreateArgs(["s-1", "--redact"])).toThrow(/--redact requires a value/);
    expect(() => parseShareCreateArgs(["s-1", "--to-peer", "--http"])).toThrow(
      /--to-peer requires a value/,
    );
  });
});

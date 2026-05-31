import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractLatestMessage, GatewayLogTailer, truncatePreview } from "./gateway-log-tail.ts";

describe("extractLatestMessage", () => {
  test("returns the `msg` field of a pino JSON line", () => {
    const line = `{"level":40,"time":1700000000000,"msg":"embedding worker downloading model"}`;
    expect(extractLatestMessage(line)).toBe("embedding worker downloading model");
  });

  test("falls back to the raw line for malformed JSON", () => {
    const line = `{"level":40,"msg":`;
    expect(extractLatestMessage(line)).toBe(line);
  });

  test("falls back to the raw line for JSON without `msg`", () => {
    expect(extractLatestMessage(`{"level":40,"time":1700000000000}`)).toBe(
      `{"level":40,"time":1700000000000}`,
    );
  });

  test("strips the `[gateway] ` prefix from plain stdout writes", () => {
    expect(extractLatestMessage("[gateway] ready (0.1.0) IPC /tmp/nimbus.sock")).toBe(
      "ready (0.1.0) IPC /tmp/nimbus.sock",
    );
  });

  test("returns plain lines unchanged", () => {
    expect(
      extractLatestMessage("--- 2026-05-04T12:00:00Z nimbus: spawning gateway (bun run) ---"),
    ).toBe("--- 2026-05-04T12:00:00Z nimbus: spawning gateway (bun run) ---");
  });
});

describe("truncatePreview", () => {
  test("returns short input unchanged", () => {
    expect(truncatePreview("hello", 10)).toBe("hello");
  });

  test("truncates with an ellipsis at the cap", () => {
    expect(truncatePreview("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("GatewayLogTailer", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-tailer-"));
    path = join(dir, "gateway.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns null when the log file does not exist", () => {
    const t = new GatewayLogTailer();
    expect(t.pollLatest(path)).toBeNull();
  });

  test("returns null when nothing has been appended since the last poll", () => {
    writeFileSync(path, "first line\n");
    const t = new GatewayLogTailer();
    expect(t.pollLatest(path)).toBe("first line");
    expect(t.pollLatest(path)).toBeNull();
  });

  test("ignores history before startOffset", () => {
    writeFileSync(path, "before\n");
    const t = new GatewayLogTailer(7);
    expect(t.pollLatest(path)).toBeNull();
    appendFileSync(path, "after\n");
    expect(t.pollLatest(path)).toBe("after");
  });

  test("returns the most recent complete line when several are appended", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, "first\nsecond\nthird\n");
    expect(t.pollLatest(path)).toBe("third");
  });

  test("does not consume a partial line until its newline arrives", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, "complete\n");
    expect(t.pollLatest(path)).toBe("complete");
    appendFileSync(path, "partial");
    expect(t.pollLatest(path)).toBeNull();
    appendFileSync(path, " continued\n");
    expect(t.pollLatest(path)).toBe("partial continued");
  });

  test("extracts pino JSON `msg` from a structured line", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, `{"level":30,"time":1700000000000,"msg":"sync scheduler started"}\n`);
    expect(t.pollLatest(path)).toBe("sync scheduler started");
  });
});

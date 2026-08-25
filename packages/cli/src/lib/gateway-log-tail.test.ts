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

describe("truncatePreview — default cap", () => {
  test("leaves a string at the default 80-char cap unchanged", () => {
    const s = "x".repeat(80);
    expect(truncatePreview(s)).toBe(s);
  });

  test("truncates past the default cap to 79 chars plus an ellipsis", () => {
    const out = truncatePreview("x".repeat(200));
    expect(out).toHaveLength(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("GatewayLogTailer — skips and error propagation", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-tailer-edge-"));
    path = join(dir, "gateway.log");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A flush can leave blank separator lines after the last real message. The
  // preview must show that message, not go blank as if nothing had happened.
  test("walks back past trailing blank lines to the last real message", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, "sync scheduler started\n\n   \n");
    expect(t.pollLatest(path)).toBe("sync scheduler started");
  });

  test("returns null when the whole new chunk is blank lines", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, "\n  \n\t\n");
    expect(t.pollLatest(path)).toBeNull();
  });

  // Blank lines must still be CONSUMED: leaving the offset behind would make
  // the next poll re-read and re-report an already-shown message.
  test("consumes a blank-only chunk so the next real line is reported once", () => {
    const t = new GatewayLogTailer();
    appendFileSync(path, "\n\n");
    expect(t.pollLatest(path)).toBeNull();
    appendFileSync(path, "ready\n");
    expect(t.pollLatest(path)).toBe("ready");
    expect(t.pollLatest(path)).toBeNull();
  });

  // Only "the log does not exist yet" is a normal condition. Any other open
  // failure must surface: swallowing it leaves the caller polling a file it
  // can never read, showing nothing and reporting no problem.
  test("propagates an open failure that is not ENOENT", () => {
    const t = new GatewayLogTailer();
    // A NUL byte is rejected by node:fs on every platform, with a code that is
    // not ENOENT — no OS-specific path trickery needed.
    expect(() => t.pollLatest(join(dir, "gate\0way.log"))).toThrow();
  });
});

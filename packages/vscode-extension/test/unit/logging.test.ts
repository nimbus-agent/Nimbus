import { describe, expect, test } from "vitest";

import { createLogger } from "../../src/logging.js";
import type { OutputChannelHandle } from "../../src/vscode-shim.js";

function makeChannel(): { ch: OutputChannelHandle; lines: string[] } {
  const lines: string[] = [];
  const ch: OutputChannelHandle = {
    appendLine: (m) => {
      lines.push(m);
    },
    show: () => undefined,
    dispose: () => undefined,
  };
  return { ch, lines };
}

describe("Logger", () => {
  test("respects logLevel — debug level shows everything", () => {
    const { ch, lines } = makeChannel();
    const log = createLogger(ch, () => "debug");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines).toHaveLength(4);
  });

  test("info level suppresses debug only", () => {
    const { ch, lines } = makeChannel();
    const log = createLogger(ch, () => "info");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes("[debug]"))).toBe(false);
  });

  test("error level suppresses warn/info/debug", () => {
    const { ch, lines } = makeChannel();
    const log = createLogger(ch, () => "error");
    log.error("e");
    log.warn("w");
    log.info("i");
    log.debug("d");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[error]");
  });
});

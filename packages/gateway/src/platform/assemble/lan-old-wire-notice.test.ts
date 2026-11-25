import { describe, expect, test } from "bun:test";
import { OLD_WIRE_NOTICE_INTERVAL_MS, oldWireNotices } from "./lan-old-wire-notice.ts";

function harness(ignored = false) {
  const lines: string[] = [];
  let t = 1_000;
  let opened = 0;
  const n = oldWireNotices("unused-log-dir", ignored, {
    logger: () => {
      opened += 1;
      return { warn: ((m: string) => lines.push(m)) as never };
    },
    nowMs: () => t,
  });
  return { n, lines, advance: (ms: number) => (t += ms), opened: () => opened };
}

describe("old-wire notices (FS3)", () => {
  test("opens no log until a notice is due", () => {
    const h = harness();
    expect(h.opened()).toBe(0);
    expect(h.lines).toEqual([]);
  });

  test("a stale min_protocol = 1 is named once at boot", () => {
    const h = harness(true);
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain("min_protocol = 1 is ignored");
  });

  test("a refused old peer is named with its address and the upgrade advice, once an hour per address", () => {
    const h = harness();
    h.n.refused("192.0.2.7");
    h.n.refused("192.0.2.7");
    h.n.refused("192.0.2.8");
    expect(h.lines).toHaveLength(2);
    expect(h.lines[0]).toContain("192.0.2.7");
    expect(h.lines[0]).toContain("Upgrade that machine");
    h.advance(OLD_WIRE_NOTICE_INTERVAL_MS);
    h.n.refused("192.0.2.7");
    expect(h.lines).toHaveLength(3);
  });
});

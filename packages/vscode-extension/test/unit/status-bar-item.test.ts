import { describe, expect, test } from "vitest";

import { formatStatusBar, type StatusBarInputs } from "../../src/status-bar/status-bar-item.js";

function inputs(p: Partial<StatusBarInputs> = {}): StatusBarInputs {
  return {
    connection: { kind: "connected", socketPath: "/run/nimbus-test/s" },
    profile: "work",
    degradedConnectorCount: 0,
    degradedConnectorNames: [],
    pendingHitlCount: 0,
    autoStartGateway: false,
    ...p,
  };
}

describe("formatStatusBar", () => {
  test("connecting state", () => {
    const r = formatStatusBar(inputs({ connection: { kind: "connecting", socketPath: "/x" } }));
    expect(r.text).toMatch(/connecting/);
    expect(r.command).toBeUndefined();
  });

  test("disconnected, autostart off", () => {
    const r = formatStatusBar(
      inputs({
        connection: { kind: "disconnected", socketPath: "/x", reason: "no socket" },
      }),
    );
    expect(r.text).toMatch(/Gateway not running/);
    expect(r.backgroundColor?.id).toMatch(/warningBackground/);
    expect(r.command).toBe("nimbus.startGateway");
  });

  test("permission denied has distinct state and tooltip", () => {
    const r = formatStatusBar(
      inputs({ connection: { kind: "permission-denied", socketPath: "/sock" } }),
    );
    expect(r.text).toMatch(/Socket permission denied/);
    expect(r.tooltip).toContain("/sock");
    expect(r.backgroundColor?.id).toMatch(/errorBackground/);
  });

  test("connected healthy", () => {
    const r = formatStatusBar(inputs());
    expect(r.text).toMatch(/work/);
    expect(r.text).toMatch(/circle-large-filled/);
    expect(r.command).toBe("nimbus.ask");
  });

  test("connected with degraded connector", () => {
    const r = formatStatusBar(
      inputs({ degradedConnectorCount: 2, degradedConnectorNames: ["github", "slack"] }),
    );
    expect(r.text).toMatch(/2 degraded/);
    expect(r.backgroundColor?.id).toMatch(/warningBackground/);
    expect(r.tooltip).toContain("github");
    expect(r.tooltip).toContain("slack");
  });

  test("HITL pending wins over degraded for click action", () => {
    const r = formatStatusBar(inputs({ degradedConnectorCount: 1, pendingHitlCount: 3 }));
    expect(r.text).toMatch(/3 pending/);
    expect(r.text).toMatch(/1 degraded/);
    expect(r.command).toBe("nimbus.showPendingHitl");
  });
});

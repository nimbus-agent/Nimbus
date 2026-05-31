import { describe, expect, test } from "bun:test";

import { formatNetworkIsolationLine } from "../../src/commands/extension-sandbox-format.ts";

describe("formatNetworkIsolationLine", () => {
  test("renders 'per-host' on a fully-active runner", () => {
    const line = formatNetworkIsolationLine({ network: "per_host", reason: null });
    expect(line).toBe("Network isolation: per-host");
  });

  test("renders 'Degraded - all-or-nothing' with the reason in parens", () => {
    const line = formatNetworkIsolationLine({
      network: "all_or_nothing",
      reason: "Windows: per-host network filtering is degraded to all-or-nothing in T2 PR 1",
    });
    expect(line).toContain("Network isolation: Degraded - all-or-nothing");
    expect(line).toContain("(Windows: per-host network filtering is degraded");
  });

  test("renders 'Degraded - all-or-nothing' without a parenthetical when reason is null", () => {
    const line = formatNetworkIsolationLine({ network: "all_or_nothing", reason: null });
    expect(line).toBe("Network isolation: Degraded - all-or-nothing");
  });

  test("renders 'Degraded - all-or-nothing' without a parenthetical when reason is empty string", () => {
    const line = formatNetworkIsolationLine({ network: "all_or_nothing", reason: "" });
    expect(line).toBe("Network isolation: Degraded - all-or-nothing");
  });

  test("renders 'sandbox posture unavailable' when the IPC call returned null", () => {
    const line = formatNetworkIsolationLine(null);
    expect(line).toBe("Network isolation: (sandbox posture unavailable)");
  });
});

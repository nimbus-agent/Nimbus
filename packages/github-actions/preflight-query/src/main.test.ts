import { afterEach, describe, expect, it, test } from "bun:test";

import {
  getBooleanInput,
  getInput,
  getIntInput,
  parseMode,
  safeString,
  sanitizeEnvelope,
} from "./main.ts";
import { decideExitCode, type Envelope } from "./render.ts";

describe("decideExitCode", () => {
  it("mode=warn, verdict=ok → 0", () => {
    expect(
      decideExitCode({
        verdict: "ok",
        mode: "warn",
        unreachable: false,
        allowGatewayFailure: false,
      }),
    ).toBe(0);
  });
  it("mode=warn, verdict=warn → 0", () => {
    expect(
      decideExitCode({
        verdict: "warn",
        mode: "warn",
        unreachable: false,
        allowGatewayFailure: false,
      }),
    ).toBe(0);
  });
  it("mode=block, verdict=ok → 0", () => {
    expect(
      decideExitCode({
        verdict: "ok",
        mode: "block",
        unreachable: false,
        allowGatewayFailure: false,
      }),
    ).toBe(0);
  });
  it("mode=block, verdict=warn → 1", () => {
    expect(
      decideExitCode({
        verdict: "warn",
        mode: "block",
        unreachable: false,
        allowGatewayFailure: false,
      }),
    ).toBe(1);
  });
  it("mode=off, verdict=warn → 0", () => {
    expect(
      decideExitCode({
        verdict: "warn",
        mode: "off",
        unreachable: false,
        allowGatewayFailure: false,
      }),
    ).toBe(0);
  });
  it("mode=block, unreachable, allow-gateway-failure=false → 1", () => {
    expect(
      decideExitCode({
        verdict: "ok",
        mode: "block",
        unreachable: true,
        allowGatewayFailure: false,
      }),
    ).toBe(1);
  });
  it("mode=block, unreachable, allow-gateway-failure=true → 0", () => {
    expect(
      decideExitCode({
        verdict: "ok",
        mode: "block",
        unreachable: true,
        allowGatewayFailure: true,
      }),
    ).toBe(0);
  });
  it("mode=warn, unreachable → 0 regardless of allow-gateway-failure", () => {
    expect(
      decideExitCode({
        verdict: "ok",
        mode: "warn",
        unreachable: true,
        allowGatewayFailure: false,
      }),
    ).toBe(0);
    expect(
      decideExitCode({ verdict: "ok", mode: "warn", unreachable: true, allowGatewayFailure: true }),
    ).toBe(0);
  });
});

describe("safeString", () => {
  test("strips control characters and truncates to maxLen", () => {
    expect(safeString("a\x00bc", 10)).toBe("abc");
    expect(safeString("abcdef", 3)).toBe("abc");
    expect(safeString("x\x07y\x1fz", 100)).toBe("xyz");
    // tab / newline / CR are deliberately allowed through the barrier
    expect(safeString("keeps\ttabs", 100)).toBe("keeps\ttabs");
  });

  test("coerces non-strings to an empty string", () => {
    expect(safeString(42, 10)).toBe("");
    expect(safeString(undefined, 10)).toBe("");
    expect(safeString(null, 10)).toBe("");
  });
});

describe("parseMode", () => {
  test("accepts block / off and defaults everything else to warn", () => {
    expect(parseMode("block")).toBe("block");
    expect(parseMode("off")).toBe("off");
    expect(parseMode("warn")).toBe("warn");
    expect(parseMode("nonsense")).toBe("warn");
    expect(parseMode("")).toBe("warn");
  });
});

describe("getInput family", () => {
  const touched: string[] = [];
  function setInput(name: string, value: string): void {
    const key = `INPUT_${name.toUpperCase().replaceAll("-", "_")}`;
    process.env[key] = value;
    touched.push(key);
  }
  afterEach(() => {
    for (const key of touched.splice(0)) {
      delete process.env[key];
    }
  });

  test("getInput reads the INPUT_<NAME> env var, defaulting to ''", () => {
    setInput("service", "checkout");
    expect(getInput("service")).toBe("checkout");
    expect(getInput("missing-thing")).toBe("");
  });

  test("getBooleanInput is true for true/1/yes only", () => {
    setInput("a", "true");
    setInput("b", "1");
    setInput("c", "YES");
    setInput("d", "no");
    expect(getBooleanInput("a")).toBe(true);
    expect(getBooleanInput("b")).toBe(true);
    expect(getBooleanInput("c")).toBe(true);
    expect(getBooleanInput("d")).toBe(false);
    expect(getBooleanInput("unset")).toBe(false);
  });

  test("getIntInput parses ints and falls back on empty/invalid", () => {
    setInput("n", "25");
    setInput("bad", "not-a-number");
    expect(getIntInput("n", 10)).toBe(25);
    expect(getIntInput("bad", 10)).toBe(10);
    expect(getIntInput("unset", 7)).toBe(7);
  });
});

function check(count: unknown, findings: unknown, gap: unknown) {
  return { count, findings, gap } as unknown as Envelope["checks"]["active_p1_incidents"];
}

describe("sanitizeEnvelope", () => {
  // The `verdict: "danger"` input below previously normalized to `"ok"`. That assertion pinned
  // the fail-open (F24a): an unrecognised verdict became a passing gate. It now normalizes to
  // `"warn"`, and the change is deliberate.
  test("sanitizes strings, coerces counts, fails an unrecognised verdict CLOSED, and maps findings", () => {
    const raw = {
      service: "che\x00ckout",
      target_ref: "main",
      computed_at: "2026-06-04",
      verdict: "danger",
      checks: {
        active_p1_incidents: check("3", [{ id: "p1", title: "DB down", url: "" }], "5m"),
        failing_ci_runs: check(2.9, [{ id: "ci1", title: "flaky", url: "https://x" }], null),
        merge_conflicts: check("oops", [], 12),
      },
    } as unknown as Envelope;

    const out = sanitizeEnvelope(raw);
    expect(out.service).toBe("checkout");
    expect(out.verdict).toBe("warn");
    expect(out.checks.active_p1_incidents.count).toBe(3);
    expect(out.checks.active_p1_incidents.findings[0]).toEqual({
      id: "p1",
      title: "DB down",
      url: null,
    });
    expect(out.checks.active_p1_incidents.gap).toBe("5m");
    expect(out.checks.failing_ci_runs.count).toBe(2);
    expect(out.checks.failing_ci_runs.findings[0]?.url).toBe("https://x");
    expect(out.checks.merge_conflicts.count).toBe(0);
    expect(out.checks.merge_conflicts.gap).toBeNull();
  });

  test("preserves a warn verdict", () => {
    const raw = {
      service: "s",
      target_ref: "r",
      computed_at: "c",
      verdict: "warn",
      checks: {
        active_p1_incidents: check(0, [], null),
        failing_ci_runs: check(0, [], null),
        merge_conflicts: check(0, [], null),
      },
    } as unknown as Envelope;
    expect(sanitizeEnvelope(raw).verdict).toBe("warn");
  });

  // F24a: `safeVerdict` previously read `raw === "warn" ? "warn" : "ok"`, so EVERY value it did
  // not recognise — a future third verdict, a typo, a truncated body, `undefined` — became `ok`,
  // and `decideExitCode` then let a `--mode block` run pass. An unrecognised verdict is exactly
  // the case where the Action does not know whether it is safe to deploy, so it must fail
  // CLOSED. Written as what cannot pass: only the literal "ok" yields "ok".
  it.each([["unknown_service"], ["block"], ["OK"], [""], [undefined], [null], [42]])(
    "coerces an unrecognised verdict %p to warn, never ok",
    (verdict) => {
      const raw = {
        service: "s",
        target_ref: "r",
        computed_at: "c",
        verdict,
        checks: {
          active_p1_incidents: check(0, [], null),
          failing_ci_runs: check(0, [], null),
          merge_conflicts: check(0, [], null),
        },
      } as unknown as Envelope;
      expect(sanitizeEnvelope(raw).verdict).toBe("warn");
    },
  );

  it("still passes a literal ok through as ok", () => {
    const raw = {
      service: "s",
      target_ref: "r",
      computed_at: "c",
      verdict: "ok",
      checks: {
        active_p1_incidents: check(0, [], null),
        failing_ci_runs: check(0, [], null),
        merge_conflicts: check(0, [], null),
      },
    } as unknown as Envelope;
    expect(sanitizeEnvelope(raw).verdict).toBe("ok");
  });
});

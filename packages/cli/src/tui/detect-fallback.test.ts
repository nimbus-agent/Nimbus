import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { currentFallbackEnv, detectFallbackReason, type FallbackEnv } from "./detect-fallback.ts";

function env(overrides: Partial<FallbackEnv> = {}): FallbackEnv {
  return {
    TERM: "xterm-256color",
    NO_COLOR: undefined,
    CI: undefined,
    isTTY: true,
    columns: 120,
    rows: 40,
    ...overrides,
  };
}

describe("detectFallbackReason", () => {
  test("returns null for a reasonable terminal", () => {
    expect(detectFallbackReason(env())).toBeNull();
  });

  test("TERM=dumb triggers fallback", () => {
    expect(detectFallbackReason(env({ TERM: "dumb" }))).toBe("TERM=dumb");
  });

  test("NO_COLOR set triggers fallback, regardless of value", () => {
    expect(detectFallbackReason(env({ NO_COLOR: "" }))).toBe("NO_COLOR");
    expect(detectFallbackReason(env({ NO_COLOR: "1" }))).toBe("NO_COLOR");
    expect(detectFallbackReason(env({ NO_COLOR: "true" }))).toBe("NO_COLOR");
  });

  test("non-TTY stdout triggers fallback", () => {
    expect(detectFallbackReason(env({ isTTY: false }))).toBe("non-TTY");
  });

  test("CI=true triggers fallback; CI=false does not", () => {
    expect(detectFallbackReason(env({ CI: "true" }))).toBe("CI=true");
    expect(detectFallbackReason(env({ CI: "false" }))).toBeNull();
  });

  test("rows below MIN_HEIGHT_THRESHOLD triggers fallback", () => {
    expect(detectFallbackReason(env({ rows: 10 }))).toBe("rows-too-small");
  });

  test("only one reason is returned — first-match wins", () => {
    const reason = detectFallbackReason(env({ TERM: "dumb", NO_COLOR: "1", CI: "true", rows: 5 }));
    expect(reason).toBe("TERM=dumb");
  });

  test("undefined rows (e.g., stdout.rows may be undefined) does not trigger", () => {
    expect(detectFallbackReason(env({ rows: undefined }))).toBeNull();
  });
});

describe("currentFallbackEnv (process globals)", () => {
  const ORIG_TERM = process.env["TERM"];
  const ORIG_NO_COLOR = process.env["NO_COLOR"];
  const ORIG_CI = process.env["CI"];
  let origIsTty: PropertyDescriptor | undefined;
  let origColumns: PropertyDescriptor | undefined;
  let origRows: PropertyDescriptor | undefined;

  beforeEach(() => {
    origIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    origColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  });

  afterEach(() => {
    if (ORIG_TERM === undefined) delete process.env["TERM"];
    else process.env["TERM"] = ORIG_TERM;
    if (ORIG_NO_COLOR === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = ORIG_NO_COLOR;
    if (ORIG_CI === undefined) delete process.env["CI"];
    else process.env["CI"] = ORIG_CI;
    if (origIsTty !== undefined) Object.defineProperty(process.stdout, "isTTY", origIsTty);
    if (origColumns !== undefined) Object.defineProperty(process.stdout, "columns", origColumns);
    if (origRows !== undefined) Object.defineProperty(process.stdout, "rows", origRows);
  });

  it("reflects current process globals when all values present", () => {
    process.env["TERM"] = "xterm-256color";
    delete process.env["NO_COLOR"];
    delete process.env["CI"];
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
    const env = currentFallbackEnv();
    expect(env.TERM).toBe("xterm-256color");
    expect(env.NO_COLOR).toBeUndefined();
    expect(env.CI).toBeUndefined();
    expect(env.isTTY).toBe(true);
    expect(env.columns).toBe(120);
    expect(env.rows).toBe(40);
  });

  it("returns isTTY=false when stdout has no TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: undefined, configurable: true });
    const env = currentFallbackEnv();
    expect(env.isTTY).toBe(false);
  });

  it("captures NO_COLOR and CI when set", () => {
    process.env["NO_COLOR"] = "1";
    process.env["CI"] = "true";
    const env = currentFallbackEnv();
    expect(env.NO_COLOR).toBe("1");
    expect(env.CI).toBe("true");
  });
});

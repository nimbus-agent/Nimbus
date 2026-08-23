import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  getConnectorMode,
  resetConnectorModeForTests,
  setConnectorMode,
} from "./connector-mode.ts";

describe("connector mode", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });
  // bun test shares ONE process across test files, so an unreset lock would change the
  // behaviour of every file that runs after this one.
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("defaults to standalone — a missing gateway wire must degrade to read-only", () => {
    expect(getConnectorMode()).toBe("standalone");
  });

  test("the gateway can opt out explicitly", () => {
    setConnectorMode("gateway");
    expect(getConnectorMode()).toBe("gateway");
  });

  test("re-asserting the same mode is a no-op, so a defensive double-call is safe", () => {
    setConnectorMode("gateway");
    expect(() => {
      setConnectorMode("gateway");
    }).not.toThrow();
    expect(getConnectorMode()).toBe("gateway");
  });

  test("a conflicting change throws rather than silently re-gating mid-process", () => {
    setConnectorMode("gateway");
    expect(() => {
      setConnectorMode("standalone");
    }).toThrow(/already locked to "gateway"/);
  });

  test("reading locks the default, so a LATE gateway wire fails loudly", () => {
    expect(getConnectorMode()).toBe("standalone");
    expect(() => {
      setConnectorMode("gateway");
    }).toThrow(/already locked to "standalone"/);
  });
});

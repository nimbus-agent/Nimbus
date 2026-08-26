import { afterEach, describe, expect, test } from "bun:test";

import {
  getConnectorMode,
  resetConnectorModeForTests,
} from "@nimbus-dev/connectors/shared/connector-mode.ts";
import { runBundledConnector } from "./run-bundled-connector.ts";

// FILE-LEVEL, and deliberately outside both describes: every test here calls
// `runBundledConnector`, which locks the process-wide connector mode to "gateway". `bun test` runs
// many test files in ONE process, so without this reset the first test in this file would change
// the mode every later file observes.
afterEach(() => {
  resetConnectorModeForTests();
});

describe("runBundledConnector", () => {
  test("calls startConnector when the module exports one", async () => {
    let started = 0;
    await runBundledConnector("guarded", {
      guarded: () =>
        Promise.resolve({
          startConnector: async () => {
            started += 1;
          },
        }),
    });
    expect(started).toBe(1);
  });

  test("resolves for a module that starts on import and exports nothing", async () => {
    let imported = 0;
    await runBundledConnector("unguarded", {
      unguarded: () => {
        imported += 1;
        return Promise.resolve({});
      },
    });
    expect(imported).toBe(1);
  });

  test("rejects an unknown id and names the known ones", async () => {
    await expect(
      runBundledConnector("nope", {
        alpha: () => Promise.resolve({}),
        beta: () => Promise.resolve({}),
      }),
    ).rejects.toThrow(/unknown connector id "nope".*alpha, beta/s);
  });

  test("rejects a missing id rather than defaulting to one", async () => {
    await expect(
      runBundledConnector(undefined, { alpha: () => Promise.resolve({}) }),
    ).rejects.toThrow(/unknown connector id/);
  });

  test("propagates a failure from the connector's own startup", async () => {
    await expect(
      runBundledConnector("boom", {
        boom: () =>
          Promise.resolve({ startConnector: () => Promise.reject(new Error("no token")) }),
      }),
    ).rejects.toThrow("no token");
  });
});

describe("runBundledConnector sets gateway mode", () => {
  test("opts the gateway out of standalone hardening BEFORE loading the connector", async () => {
    let modeAtLoad: string | undefined;
    const registry = {
      probe: () => {
        // Observed at load time, which is when a real connector registers its tools. A mode set
        // after the import would be read too late to affect registration.
        modeAtLoad = getConnectorMode();
        return Promise.resolve({});
      },
    };

    await runBundledConnector("probe", registry);

    expect(modeAtLoad).toBe("gateway");
  });

  test("an unknown id still throws, and does so without leaving the mode unset", async () => {
    await expect(runBundledConnector("nope", {})).rejects.toThrow(/unknown connector id/);
    expect(getConnectorMode()).toBe("gateway");
  });
});

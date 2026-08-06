import { describe, expect, test } from "bun:test";

import { runBundledConnector } from "./run-bundled-connector.ts";

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

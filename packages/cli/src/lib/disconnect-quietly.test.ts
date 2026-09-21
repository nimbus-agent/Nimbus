import { describe, expect, it } from "bun:test";

import { disconnectQuietly } from "./disconnect-quietly.ts";

describe("disconnectQuietly", () => {
  it("calls disconnect() exactly once", async () => {
    let calls = 0;
    await disconnectQuietly({
      disconnect: async () => {
        calls += 1;
      },
    });
    expect(calls).toBe(1);
  });

  it("swallows an async rejection", async () => {
    await expect(
      disconnectQuietly({
        disconnect: async () => {
          throw new Error("socket already torn down");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("swallows a synchronous throw from a non-async disconnect()", async () => {
    await expect(
      disconnectQuietly({
        disconnect: (): void => {
          throw new Error("sync teardown failure");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("does not replace an error already propagating out of a try/finally", async () => {
    const run = async (): Promise<void> => {
      try {
        throw new Error("the real failure");
      } finally {
        await disconnectQuietly({
          disconnect: async () => {
            throw new Error("teardown failure");
          },
        });
      }
    };
    await expect(run()).rejects.toThrow("the real failure");
  });
});

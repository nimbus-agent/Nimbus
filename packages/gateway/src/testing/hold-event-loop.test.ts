/**
 * `awaitHoldingEventLoop` is what lets a test await a promise that only an unref'd production
 * timer settles. Run this file ALONE on Windows under Bun 1.3 to see why it exists: without the
 * hold, nothing in the first test is ref'd, the wait spins, and the unref'd timer never fires (see
 * the module doc). Elsewhere — Linux, Bun 1.4, or a combined run in which another file's ref'd
 * handle already keeps the loop alive — that test passes either way, which is why the hold itself
 * is also pinned directly below, independently of the platform.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { awaitHoldingEventLoop } from "./hold-event-loop.ts";

describe("awaitHoldingEventLoop", () => {
  test("settles a promise that only an unref'd timer resolves", async () => {
    const value = await awaitHoldingEventLoop(
      new Promise<string>((resolve) => {
        setTimeout(() => resolve("fired"), 10).unref();
      }),
    );
    expect(value).toBe("fired");
  });

  test("passes the rejection through unchanged", async () => {
    const boom = new Error("boom");
    await expect(awaitHoldingEventLoop(Promise.reject(boom))).rejects.toBe(boom);
  });

  test("holds one ref'd interval while the promise is pending and releases it once it settles", async () => {
    for (const outcome of ["resolve", "reject"] as const) {
      const setSpy = spyOn(globalThis, "setInterval");
      const clearSpy = spyOn(globalThis, "clearInterval");
      try {
        let settle: () => void = () => {};
        const pending = new Promise<string>((resolve, reject) => {
          settle = () => (outcome === "resolve" ? resolve("done") : reject(new Error("nope")));
        });
        const awaited = awaitHoldingEventLoop(pending);

        // Held for the whole wait: a ref'd handle exists and nothing has released it yet.
        expect(setSpy).toHaveBeenCalledTimes(1);
        const hold = setSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
        expect(hold.hasRef()).toBe(true);
        expect(clearSpy).not.toHaveBeenCalled();

        settle();
        await awaited.catch(() => undefined);

        // Released on settling, on either path — so it can never leak into the next test.
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(clearSpy.mock.calls[0]?.[0]).toBe(hold);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
    }
  });
});

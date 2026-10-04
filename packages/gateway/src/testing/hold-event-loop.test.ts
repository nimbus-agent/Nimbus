/**
 * `awaitHoldingEventLoop` is what lets a test await a promise that only an unref'd production
 * timer settles. Run this file ALONE on Windows under Bun 1.3 to see why it exists: without the
 * hold, nothing in the first test is ref'd, the wait spins, and the unref'd timer never fires (see
 * the module doc). Elsewhere — Linux, Bun 1.4, or a combined run in which another file's ref'd
 * handle already keeps the loop alive — that test passes either way, which is why the hold itself
 * is also pinned directly below, independently of the platform.
 */
import { afterAll, describe, expect, type Mock, spyOn, test } from "bun:test";
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

        // Released on settling, on either path. (A promise that never settles is the next block.)
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(clearSpy.mock.calls[0]?.[0]).toBe(hold);
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
    }
  });

  describe("when the test ends with the promise still pending, as a timed-out test does", () => {
    // A promise that never settles never reaches the helper's `finally`, so the hold must also end
    // with the test. The first test below ends with the await still pending; `bun test` runs its
    // onTestFinished hooks before the second test, which checks the hold was released anyway. A
    // hold that outlived its test would keep the loop alive for every later test in the process,
    // and on Windows that lets a bare await of an unref'd timer pass instead of hanging.
    let hold: ReturnType<typeof setInterval> | undefined;
    let clearSpy: Mock<typeof clearInterval> | undefined;
    afterAll(() => clearSpy?.mockRestore());

    test("the hold is in place while that test runs", () => {
      const setSpy = spyOn(globalThis, "setInterval");
      try {
        void awaitHoldingEventLoop(new Promise<never>(() => {}));
        expect(setSpy).toHaveBeenCalledTimes(1);
        hold = setSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
      } finally {
        setSpy.mockRestore();
      }
      expect(hold.hasRef()).toBe(true);
      clearSpy = spyOn(globalThis, "clearInterval");
    });

    test("and is released once that test has finished, though the promise never settled", () => {
      expect(hold).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(hold);
    });
  });
});

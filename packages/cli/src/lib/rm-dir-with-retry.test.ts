import { describe, expect, test } from "bun:test";

import { rmDirWithRetry } from "./rm-dir-with-retry.ts";

function err(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** An `rm` that fails with `codes` in order, then succeeds. */
function flaky(codes: string[]) {
  const calls: string[] = [];
  return {
    calls,
    rm: (p: string) => {
      calls.push(p);
      const c = codes.shift();
      if (c !== undefined) throw err(c);
    },
  };
}

describe("rmDirWithRetry (nimbus demo root cleanup)", () => {
  test("retries EBUSY, EPERM and ENOTEMPTY, then succeeds", () => {
    const f = flaky(["EBUSY", "EPERM", "ENOTEMPTY"]);
    const slept: number[] = [];
    rmDirWithRetry("/d", { rm: f.rm, sleep: (ms) => slept.push(ms), delayMs: 7 });
    expect(f.calls).toHaveLength(4);
    expect(slept).toEqual([7, 7, 7]);
  });

  test("any other error is rethrown at once, unchanged", () => {
    const f = flaky(["EACCES"]);
    const slept: number[] = [];
    expect(() => rmDirWithRetry("/d", { rm: f.rm, sleep: (ms) => slept.push(ms) })).toThrow(
      "EACCES",
    );
    expect(f.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("gives up after `attempts` and rethrows the last error", () => {
    const f = flaky(["EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
    expect(() => rmDirWithRetry("/d", { rm: f.rm, sleep: () => {}, attempts: 3 })).toThrow("EBUSY");
    expect(f.calls).toHaveLength(3);
  });

  test("an error with no string code is not retried", () => {
    let n = 0;
    const rm = (): void => {
      n++;
      throw new Error("no code");
    };
    expect(() => rmDirWithRetry("/d", { rm, sleep: () => {} })).toThrow("no code");
    expect(n).toBe(1);
  });
});

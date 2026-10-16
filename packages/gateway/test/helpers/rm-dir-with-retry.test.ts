import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmDirWithRetry } from "./rm-dir-with-retry.ts";

const err = (code: string): Error => Object.assign(new Error(code), { code });

describe("rmDirWithRetry", () => {
  test("retries a lock error until the remove succeeds", () => {
    let calls = 0;
    const slept: number[] = [];
    rmDirWithRetry("/x", {
      delayMs: 7,
      rm: () => {
        calls++;
        if (calls < 3) throw err("EBUSY");
      },
      sleep: (ms) => slept.push(ms),
    });
    expect(calls).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  test("rethrows a non-lock error at once", () => {
    let calls = 0;
    expect(() =>
      rmDirWithRetry("/x", {
        rm: () => {
          calls++;
          throw err("EACCES");
        },
        sleep: () => {},
      }),
    ).toThrow("EACCES");
    expect(calls).toBe(1);
  });

  test("gives up after the last attempt with the original error", () => {
    let calls = 0;
    expect(() =>
      rmDirWithRetry("/x", {
        attempts: 4,
        rm: () => {
          calls++;
          throw err("EPERM");
        },
        sleep: () => {},
      }),
    ).toThrow("EPERM");
    expect(calls).toBe(4);
  });

  // The real thing, which is why this helper exists: a DIFFERENT process holds a file open with no
  // share-delete, so the first remove fails EBUSY; it closes the handle ~1.5 s in. A bare
  // `rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay })` fails here in ~1 ms.
  test.skipIf(process.platform !== "win32")(
    "outlasts a real Windows lock held by another process",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-rm-retry-"));
      const file = join(dir, "held.txt");
      writeFileSync(file, "x");
      const child = Bun.spawn([
        "powershell",
        "-NoProfile",
        "-Command",
        `$s=[IO.File]::Open('${file}','Open','Read','None'); Start-Sleep -Milliseconds 1500; $s.Close()`,
      ]);
      try {
        Bun.sleepSync(700);
        // Premise first, or this would pass vacuously on a runner where the lock never took.
        expect(() =>
          rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }),
        ).toThrow();
        rmDirWithRetry(dir);
        expect(existsSync(dir)).toBe(false);
      } finally {
        await child.exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

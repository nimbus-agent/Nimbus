import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmDirWithRetry } from "./rm-dir-with-retry.ts";

const err = (code: string): Error => Object.assign(new Error(code), { code });

/** Resolves once `stream` has emitted a line equal to `line`; rejects after `ms` or at EOF. */
async function waitForLine(
  stream: ReadableStream<Uint8Array>,
  line: string,
  ms: number,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + ms;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`no "${line}" from the child within ${String(ms)} ms`);
      const next = await Promise.race([
        reader.read(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), remaining)),
      ]);
      if (next === "timeout")
        throw new Error(`no "${line}" from the child within ${String(ms)} ms`);
      if (next.done) throw new Error(`the child exited before printing "${line}"`);
      buffered += decoder.decode(next.value, { stream: true });
      if (buffered.split(/\r?\n/).some((l) => l.trim() === line)) return;
    }
  } finally {
    reader.releaseLock();
  }
}

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
  // share-delete, so the first remove fails EBUSY; it closes the handle 1.5 s after it took it. A
  // bare `rmSync(dir, { recursive: true, force: true, maxRetries, retryDelay })` fails here in ~1 ms.
  test.skipIf(process.platform !== "win32")(
    "outlasts a real Windows lock held by another process",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-rm-retry-"));
      const file = join(dir, "held.txt");
      writeFileSync(file, "x");
      const child = Bun.spawn(
        [
          "powershell",
          "-NoProfile",
          "-Command",
          // The path arrives through the environment, never spliced into the script, so a profile
          // name containing a quote (O'Connor) cannot break the command.
          "$s=[IO.File]::Open($env:NIMBUS_HELD_FILE,'Open','Read','None'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds 1500; $s.Close()",
        ],
        { stdout: "pipe", env: { ...process.env, NIMBUS_HELD_FILE: file } },
      );
      try {
        // Wait for the child to CONFIRM it holds the lock — a fixed sleep races PowerShell's
        // start-up, which on a slow runner can outlast it and make the premise below fail.
        await waitForLine(child.stdout, "locked", 20_000);
        // Premise first, or this would pass vacuously on a runner where the lock never took.
        expect(() =>
          rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 }),
        ).toThrow();
        // 10 s of retries against a 1.5 s lock: margin for a slow runner, never an unbounded wait.
        rmDirWithRetry(dir, { attempts: 100 });
        expect(existsSync(dir)).toBe(false);
      } finally {
        await child.exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";

import { type MakeInterface, readLine } from "./read-line.ts";

test("asks once, trims the answer, always closes the interface", async () => {
  let closed = 0;
  let asked = "";
  const make = (() => ({
    question: async (q: string) => {
      asked = q;
      return "  2 \n";
    },
    close: () => {
      closed += 1;
    },
  })) as unknown as MakeInterface;
  expect(await readLine("Which one? ", make)).toBe("2");
  expect(asked).toBe("Which one? ");
  expect(closed).toBe(1);
});

// The `make` parameter's default IS `node:readline/promises`'s real `createInterface` — the branch
// the test above (a caller-supplied `make`) never takes. Exercised here against real, controllable
// (non-TTY) streams rather than excluded from coverage, so a real wiring regression (e.g. binding
// the wrong stream) still fails a test.
test("defaults to the real readline constructor, reading process.stdin", async () => {
  const input = new Readable({ read() {} });
  const written: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      written.push(String(chunk));
      cb();
    },
  });
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  Object.defineProperty(process, "stdout", { value: output, configurable: true });
  try {
    const pending = readLine("Pick one: ");
    input.push("  answer  \n");
    expect(await pending).toBe("answer");
    expect(written.join("")).toContain("Pick one: ");
  } finally {
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, configurable: true });
  }
});

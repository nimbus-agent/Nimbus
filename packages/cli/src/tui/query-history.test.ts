import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QUERY_HISTORY_CAP } from "./constants.ts";
import { appendQuery, readHistory } from "./query-history.ts";

let tmpDir: string;
let historyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-tui-hist-"));
  historyPath = join(tmpDir, "tui-query-history.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readHistory", () => {
  test("returns empty array when file does not exist", async () => {
    expect(await readHistory(historyPath)).toEqual([]);
  });

  test("reads a valid file", async () => {
    writeFileSync(historyPath, JSON.stringify({ entries: ["a", "b", "c"] }));
    expect(await readHistory(historyPath)).toEqual(["a", "b", "c"]);
  });

  test("returns empty array on corrupt JSON", async () => {
    writeFileSync(historyPath, "{not json");
    expect(await readHistory(historyPath)).toEqual([]);
  });

  test("returns empty array on valid JSON with wrong shape", async () => {
    writeFileSync(historyPath, JSON.stringify({ somethingElse: 42 }));
    expect(await readHistory(historyPath)).toEqual([]);
  });
});

describe("appendQuery", () => {
  test("appends to empty history", async () => {
    await appendQuery(historyPath, "first");
    expect(await readHistory(historyPath)).toEqual(["first"]);
  });

  test("appends multiple entries in order", async () => {
    await appendQuery(historyPath, "a");
    await appendQuery(historyPath, "b");
    await appendQuery(historyPath, "c");
    expect(await readHistory(historyPath)).toEqual(["a", "b", "c"]);
  });

  test("dedups on repeat-of-last", async () => {
    await appendQuery(historyPath, "a");
    await appendQuery(historyPath, "a");
    await appendQuery(historyPath, "a");
    expect(await readHistory(historyPath)).toEqual(["a"]);
  });

  test("does not dedup non-adjacent repeats", async () => {
    await appendQuery(historyPath, "a");
    await appendQuery(historyPath, "b");
    await appendQuery(historyPath, "a");
    expect(await readHistory(historyPath)).toEqual(["a", "b", "a"]);
  });

  test("caps at QUERY_HISTORY_CAP entries, trimming oldest", async () => {
    for (let i = 0; i < QUERY_HISTORY_CAP + 10; i++) {
      await appendQuery(historyPath, `q${String(i)}`);
    }
    const history = await readHistory(historyPath);
    expect(history.length).toBe(QUERY_HISTORY_CAP);
    expect(history[0]).toBe("q10");
    expect(history.at(-1)).toBe(`q${String(QUERY_HISTORY_CAP + 9)}`);
  });

  test("recovers from corrupt file by overwriting", async () => {
    writeFileSync(historyPath, "{not json");
    await appendQuery(historyPath, "recovery");
    expect(await readHistory(historyPath)).toEqual(["recovery"]);
  });

  test("ignores empty-string queries", async () => {
    await appendQuery(historyPath, "");
    expect(await readHistory(historyPath)).toEqual([]);
  });

  test("ignores whitespace-only queries", async () => {
    await appendQuery(historyPath, "   \t  ");
    expect(await readHistory(historyPath)).toEqual([]);
  });
});

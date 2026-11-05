import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileObsidianGrantLedger, obsidianGrantLedgerFile } from "./obsidian-grant-ledger.ts";

const temps: string[] = [];

function configDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-obs-ledger-"));
  temps.push(d);
  return d;
}

afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the Obsidian grant ledger file", () => {
  test("lives under configDir/sandbox-grants (no sandboxed child is granted configDir)", () => {
    const c = configDir();
    expect(obsidianGrantLedgerFile(c)).toBe(
      join(c, "sandbox-grants", "obsidian-write-ledger.json"),
    );
  });

  test("a missing file is an empty ledger; save then load round-trips; no temp file is left", () => {
    const file = obsidianGrantLedgerFile(configDir());
    const l = fileObsidianGrantLedger(file);
    expect(l.load()).toEqual([]);
    l.save(["/n/a", "/n/b"]);
    expect(l.load()).toEqual(["/n/a", "/n/b"]);
    l.save([]);
    expect(l.load()).toEqual([]);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  test("a malformed ledger THROWS (the spawn then refuses), whatever its shape", () => {
    const file = obsidianGrantLedgerFile(configDir());
    mkdirSync(join(file, ".."), { recursive: true });
    for (const body of ["{not json", "{}", '["/a", 7]', "null"]) {
      writeFileSync(file, body);
      expect(() => fileObsidianGrantLedger(file).load(), body).toThrow();
    }
  });

  test("a ledger path that cannot be read (a directory) throws rather than reading as empty", () => {
    const file = obsidianGrantLedgerFile(configDir());
    mkdirSync(file, { recursive: true });
    expect(() => fileObsidianGrantLedger(file).load()).toThrow();
  });
});

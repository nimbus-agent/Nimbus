import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDailyNoteFilename, resolveDailyNotePath } from "./obsidian-daily-note.ts";

test("formatDailyNoteFilename handles the supported subset", () => {
  const d = new Date("2026-05-10T03:04:00Z");
  expect(formatDailyNoteFilename("YYYY-MM-DD", d)).toBe("2026-05-10");
  expect(formatDailyNoteFilename("YY-MM-DD", d)).toBe("26-05-10");
  expect(formatDailyNoteFilename("YYYY/MM/DD", d)).toBe("2026/05/10");
  expect(formatDailyNoteFilename("YYYY-MM-DD HH:mm", d)).toBe("2026-05-10 03:04");
});

test("formatDailyNoteFilename leaves unsupported tokens untouched", () => {
  const d = new Date("2026-05-10T03:04:00Z");
  expect(formatDailyNoteFilename("YYYY-MM-DD-dddd", d)).toBe("2026-05-10-dddd");
});

test("resolveDailyNotePath uses .obsidian/daily-notes.json folder + format when present", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "Daily", format: "YYYY-MM-DD" }),
  );
  const d = new Date("2026-05-10T00:00:00Z");
  const out = resolveDailyNotePath(root, d);
  expect(out.relativePath.replaceAll("\\", "/")).toBe("Daily/2026-05-10.md");
  expect(out.absolutePath.replaceAll("\\", "/").endsWith("Daily/2026-05-10.md")).toBe(true);
  expect(out.warning).toBe(undefined);
});

test("resolveDailyNotePath falls back to YYYY-MM-DD.md at the vault root when daily-notes.json missing", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  const d = new Date("2026-05-10T00:00:00Z");
  const out = resolveDailyNotePath(root, d);
  expect(out.relativePath).toBe("2026-05-10.md");
  expect(out.warning).toBe(undefined);
});

test("resolveDailyNotePath emits a warning when the JSON is malformed", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "daily-notes.json"), "{not json");
  const d = new Date("2026-05-10T00:00:00Z");
  const out = resolveDailyNotePath(root, d);
  expect(out.relativePath).toBe("2026-05-10.md");
  expect(out.warning).toBeDefined();
});

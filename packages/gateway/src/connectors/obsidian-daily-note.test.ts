import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
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

// Covers: daily-notes.json contains JSON null (parsed !== null guard → warning)
test("resolveDailyNotePath emits a warning when daily-notes.json is JSON null", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "daily-notes.json"), "null");
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  // Falls back to default format
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBe("daily-notes.json is not an object");
});

// Covers: daily-notes.json contains a non-object JSON value (string, number, array)
test("resolveDailyNotePath does NOT warn for a JSON array (treated as Record → defaults)", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "daily-notes.json"), "[1,2,3]");
  // Arrays are typeof "object" but NOT hit by the null check. They pass through
  // as a Record, so folder/format will be missing — folder defaults to "" and
  // format defaults to "YYYY-MM-DD". No warning expected.
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: daily-notes.json is a primitive non-null (e.g. a bare number)
test("resolveDailyNotePath emits a warning when daily-notes.json is a JSON number", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(join(root, ".obsidian", "daily-notes.json"), "42");
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBe("daily-notes.json is not an object");
});

// Covers: folder field is not a string → defaults to ""
test("resolveDailyNotePath defaults folder to empty string when folder field is not a string", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: 99, format: "YYYY-MM-DD" }),
  );
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  // No folder prefix — file is at vault root
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: format field is not a string → defaults to "YYYY-MM-DD"
test("resolveDailyNotePath defaults format when format field is not a string", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "", format: false }),
  );
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: format field is an empty string → defaults to "YYYY-MM-DD"
test("resolveDailyNotePath defaults format when format field is an empty string", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "", format: "" }),
  );
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: folder with trailing slash — stripTrailingChars removes it
test("resolveDailyNotePath strips trailing slash from folder", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "Notes/", format: "YYYY-MM-DD" }),
  );
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  // Should not have double slash
  expect(out.relativePath.replaceAll("\\", "/")).toMatch(/^Notes\/\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: folder with trailing backslash — stripTrailingChars removes it
test("resolveDailyNotePath strips trailing backslash from folder", () => {
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  writeFileSync(
    join(root, ".obsidian", "daily-notes.json"),
    JSON.stringify({ folder: "Notes\\", format: "YYYY-MM-DD" }),
  );
  const now = new Date();
  const out = resolveDailyNotePath(root, now);
  expect(out.relativePath.replaceAll("\\", "/")).toMatch(/^Notes\/\d{4}-\d{2}-\d{2}\.md$/);
  expect(out.warning).toBeUndefined();
});

// Covers: pad2 when n >= 10 (double-digit month/day/hour/minute)
test("formatDailyNoteFilename correctly pads two-digit values", () => {
  // December 31 at 23:59 — all fields >= 10
  const d = new Date("2025-12-31T23:59:00Z");
  expect(formatDailyNoteFilename("YYYY-MM-DD HH:mm", d)).toBe("2025-12-31 23:59");
});

// Covers: pad2 when n < 10 (single-digit month/day/hour/minute → zero-padded)
test("formatDailyNoteFilename correctly pads single-digit values with leading zero", () => {
  // January 1 at 01:01
  const d = new Date("2025-01-01T01:01:00Z");
  expect(formatDailyNoteFilename("YYYY-MM-DD HH:mm", d)).toBe("2025-01-01 01:01");
});

// Covers: YY branch for a year where year % 100 < 10 (e.g. 2005 → "05")
test("formatDailyNoteFilename pads two-digit year with leading zero when needed", () => {
  const d = new Date("2005-03-07T00:00:00Z");
  expect(formatDailyNoteFilename("YY-MM-DD", d)).toBe("05-03-07");
});

// Covers: readFileSync catch arm — file exists but cannot be read (non-Windows only)
test("resolveDailyNotePath emits a warning when daily-notes.json exists but is unreadable", () => {
  if (platform() === "win32") {
    // chmod 000 is not reliably enforceable on Windows; skip this branch there.
    expect(true).toBe(true); // placeholder so the test is counted
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "obsidian-dn-"));
  mkdirSync(join(root, ".obsidian"), { recursive: true });
  const cfgPath = join(root, ".obsidian", "daily-notes.json");
  writeFileSync(cfgPath, JSON.stringify({ folder: "", format: "YYYY-MM-DD" }));
  chmodSync(cfgPath, 0o000);
  const now = new Date();
  try {
    const out = resolveDailyNotePath(root, now);
    expect(out.warning).toBe("could not read daily-notes.json");
    expect(out.relativePath).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
  } finally {
    try {
      chmodSync(cfgPath, 0o644);
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

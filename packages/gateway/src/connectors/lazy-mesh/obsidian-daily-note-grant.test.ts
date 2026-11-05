/**
 * The Obsidian sandbox write grant is ONE file per vault, today's daily note (the owner's ruling on
 * the final review's finding 1). Real temp trees and real links (junctions on win32).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverVaultsForWriteGrant } from "../obsidian-discovery.ts";
import {
  type DailyNoteGrantDeps,
  dailyNotePattern,
  obsidianDailyNoteGrant,
  prepareDailyNote,
  utcDay,
} from "./obsidian-daily-note-grant.ts";

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = new Date(Date.UTC(2026, 10, 5, 23, 30));
const DAY = "2026-11-05";

function base(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-obs-dn-")));
  temps.push(d);
  return d;
}

function vault(root: string, name: string, config?: Record<string, unknown>): string {
  const v = join(root, name);
  mkdirSync(join(v, ".obsidian"), { recursive: true });
  if (config !== undefined)
    writeFileSync(join(v, ".obsidian", "daily-notes.json"), JSON.stringify(config));
  return v;
}

function deps(b: string, over: Partial<DailyNoteGrantDeps> = {}): DailyNoteGrantDeps {
  return {
    discoverVaults: (roots) => discoverVaultsForWriteGrant(roots),
    realpath: (p) => realpathSync.native(p),
    homeDir: join(b, "home"),
    protectedRoots: [],
    platform: process.platform,
    now: () => NOW,
    ...over,
  };
}

function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

const fs = () => ({
  lstat: (p: string) => lstatSync(p),
  mkdir: (p: string) => mkdirSync(p),
  createExclusive: (p: string) => writeFileSync(p, "", { flag: "wx" }),
  realpath: (p: string) => realpathSync.native(p),
});

describe("obsidianDailyNoteGrant: today's note, and nothing else", () => {
  test("the default config: <vault>/YYYY-MM-DD.md for today in UTC, created empty on the host", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "Work");
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.day).toBe(DAY);
    expect(g.files).toEqual([join(v, `${DAY}.md`)]);
    expect(readFileSync(join(v, `${DAY}.md`), "utf8")).toBe("");
    expect(g.skippedNotes).toEqual([]);
  });

  test("the vault's daily-notes folder and format, folder created; an existing note is kept as is", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "Work", { folder: "Journal/Daily", format: "YYYY.MM.DD" });
    const g1 = obsidianDailyNoteGrant([root], deps(b));
    const file = join(v, "Journal", "Daily", "2026.11.05.md");
    expect(g1.files).toEqual([file]);
    writeFileSync(file, "kept");
    expect(obsidianDailyNoteGrant([root], deps(b)).files).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe("kept");
  });

  test("the UTC date names the note even when the local date differs", () => {
    expect(utcDay(new Date(Date.UTC(2026, 10, 5, 23, 59)))).toBe("2026-11-05");
    expect(utcDay(new Date(Date.UTC(2026, 10, 6, 0, 0)))).toBe("2026-11-06");
  });

  test("a daily folder inside .obsidian or .git is refused (plugins and hooks live there)", () => {
    const b = base();
    const root = join(b, "notes");
    vault(root, "A", { folder: ".obsidian/plugins/x" });
    vault(root, "B", { folder: ".git/hooks" });
    vault(root, "C", { folder: "Notes/.OBSIDIAN" });
    const g = obsidianDailyNoteGrant([root], deps(b));
    const reasons = g.skippedNotes.map((s) => s.reason);
    expect(g.files).toEqual(
      process.platform === "win32" ? [] : [join(root, "C", "Notes", ".OBSIDIAN", `${DAY}.md`)],
    );
    expect(reasons.filter((r) => r === "config-dir").length).toBe(
      process.platform === "win32" ? 3 : 2,
    );
    expect(existsSync(join(root, "A", ".obsidian", "plugins"))).toBe(false);
  });

  test("a daily folder that leaves the vault is refused", () => {
    const b = base();
    const root = join(b, "notes");
    vault(root, "A", { folder: "../escape" });
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.files).toEqual([]);
    expect(g.skippedNotes.map((s) => s.reason)).toEqual(["outside-vault"]);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  test("a daily folder that is a link is refused, and nothing is created through it", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "A", { folder: "Daily" });
    mkdirSync(join(b, "outside"));
    linkDir(join(b, "outside"), join(v, "Daily"));
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.files).toEqual([]);
    expect(g.skippedNotes.map((s) => s.reason)).toEqual(["link"]);
    expect(existsSync(join(b, "outside", `${DAY}.md`))).toBe(false);
  });

  test("today's note planted as a hard link to another file is refused", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "A");
    const other = join(root, "elsewhere.md");
    writeFileSync(other, "not today's note");
    linkSync(other, join(v, `${DAY}.md`));
    expect(statSync(other).nlink).toBe(2);
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.files).toEqual([]);
    expect(g.skippedNotes.map((s) => s.reason)).toEqual(["hard-link"]);
  });

  test("today's note that is a symlink is refused (when this OS can make one)", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "A");
    writeFileSync(join(b, "target.md"), "x");
    try {
      symlinkSync(join(b, "target.md"), join(v, `${DAY}.md`), "file");
    } catch {
      console.log("[daily-note-grant] file symlinks unavailable here");
      return;
    }
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.files).toEqual([]);
    expect(g.skippedNotes.map((s) => s.reason)).toEqual(["link"]);
  });

  test("a folder where the note should be is refused; a file where a folder should be too", () => {
    const b = base();
    const root = join(b, "notes");
    const a = vault(root, "A");
    mkdirSync(join(a, `${DAY}.md`));
    const c = vault(root, "C", { folder: "Daily" });
    writeFileSync(join(c, "Daily"), "a file");
    const g = obsidianDailyNoteGrant([root], deps(b));
    expect(g.files).toEqual([]);
    expect(g.skippedNotes.map((s) => s.reason)).toEqual(["not-a-file", "not-a-file"]);
  });

  test("the host failing to create the note is unwritable, never a grant", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "A");
    const r = prepareDailyNote(v, NOW, process.platform, {
      ...fs(),
      createExclusive: () => {
        throw new Error("EACCES");
      },
    });
    expect(r).toEqual({ path: join(v, `${DAY}.md`), reason: "unwritable" });
  });

  test("a note whose real path is not the vault's plus its names is refused as a link", () => {
    const b = base();
    const root = join(b, "notes");
    const v = vault(root, "A");
    const r = prepareDailyNote(v, NOW, process.platform, {
      ...fs(),
      realpath: (p) => (p === v ? v : join(b, "elsewhere.md")),
    });
    expect(r).toEqual({ path: join(v, `${DAY}.md`), reason: "link" });
  });

  test("no grant without vaults, and skipped vaults are reported", () => {
    const b = base();
    expect(obsidianDailyNoteGrant([join(b, "absent")], deps(b))).toEqual({
      day: DAY,
      files: [],
      skippedVaults: [],
      skippedNotes: [],
    });
  });
});

describe("dailyNotePattern (the enable prompt; creates nothing)", () => {
  test("the folder and the format, as a pattern", () => {
    const b = base();
    const v = vault(b, "Work", { folder: "Daily", format: "YYYY-MM-DD" });
    expect(dailyNotePattern(v, process.platform)).toEqual({
      pattern: join(v, "Daily", "YYYY-MM-DD.md"),
    });
    expect(existsSync(join(v, "Daily"))).toBe(false);
    const d = vault(b, "Default");
    expect(dailyNotePattern(d, process.platform)).toEqual({ pattern: join(d, "YYYY-MM-DD.md") });
  });

  test("a folder inside .obsidian, or leaving the vault, is named as never writable", () => {
    const b = base();
    expect(
      dailyNotePattern(vault(b, "A", { folder: ".obsidian" }), process.platform),
    ).toMatchObject({
      reason: "config-dir",
    });
    expect(dailyNotePattern(vault(b, "B", { folder: "../x" }), process.platform)).toMatchObject({
      reason: "outside-vault",
    });
  });
});

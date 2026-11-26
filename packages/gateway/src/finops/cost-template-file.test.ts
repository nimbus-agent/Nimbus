import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COST_TEMPLATE_MAX_BYTES,
  CostTemplateFileError,
  readCostTemplateFile,
} from "./cost-template-file.ts";

/** Whether this host may create a FILE symlink (Windows needs developer mode or admin). */
function canSymlinkFiles(): boolean {
  const d = mkdtempSync(join(tmpdir(), "nimbus-symlink-probe-"));
  try {
    writeFileSync(join(d, "t"), "x");
    symlinkSync(join(d, "t"), join(d, "l"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const CAN_SYMLINK_FILES = canSymlinkFiles();

let root: string;
let configDir: string;
let templates: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-cost-template-"));
  configDir = join(root, "config");
  templates = join(configDir, "cost-templates");
  mkdirSync(templates, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function reason(file: string): string {
  try {
    readCostTemplateFile(configDir, file);
  } catch (e) {
    if (e instanceof CostTemplateFileError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("readCostTemplateFile", () => {
  test("reads a plain UTF-8 file from cost-templates/", () => {
    writeFileSync(join(templates, "weekly.md"), "Checkout: {total} — ünïcode\n");
    expect(readCostTemplateFile(configDir, "weekly.md")).toBe("Checkout: {total} — ünïcode\n");
  });

  test("a name that is not a plain file name is refused before any path is built", () => {
    for (const name of ["../x.md", "/etc/passwd", "a/b.md", "a\\b.md", ".hidden", "C:x.md", ""]) {
      expect(reason(name)).toContain("not a plain file name");
    }
  });

  test("a missing file, a folder, and a missing cost-templates folder are refused", () => {
    expect(reason("nope.md")).toContain("no template file nope.md");
    mkdirSync(join(templates, "dir.md"));
    expect(reason("dir.md")).toContain("is not a regular file");
    rmSync(templates, { recursive: true, force: true });
    expect(reason("weekly.md")).toContain("no cost-templates folder");
  });

  test("a file over 64 KiB and a file that is not UTF-8 are refused", () => {
    writeFileSync(join(templates, "big.md"), "x".repeat(COST_TEMPLATE_MAX_BYTES + 1));
    expect(reason("big.md")).toContain("larger than 64 KiB");
    writeFileSync(join(templates, "exact.md"), "x".repeat(COST_TEMPLATE_MAX_BYTES));
    expect(readCostTemplateFile(configDir, "exact.md")).toHaveLength(COST_TEMPLATE_MAX_BYTES);
    writeFileSync(join(templates, "bin.md"), Buffer.from([0x48, 0xff, 0xfe, 0x49]));
    expect(reason("bin.md")).toContain("not valid UTF-8");
  });

  test("a cost-templates folder that is a link (a junction on Windows) is refused", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "weekly.md"), "outside");
    rmSync(templates, { recursive: true, force: true });
    symlinkSync(elsewhere, templates, "junction");
    expect(reason("weekly.md")).toContain("the cost-templates folder is a link");
  });

  test.skipIf(!CAN_SYMLINK_FILES)("a template file that is a link is refused", () => {
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "outside the folder");
    symlinkSync(outside, join(templates, "weekly.md"), "file");
    expect(reason("weekly.md")).toContain("is a link");
  });
});

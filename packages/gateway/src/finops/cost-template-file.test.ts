import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, type Stats, symlinkSync, writeFileSync } from "node:fs";
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

describe("readCostTemplateFile: a cost-templates that is not a folder", () => {
  test("a regular file named cost-templates is refused", () => {
    rmSync(templates, { recursive: true, force: true });
    writeFileSync(templates, "not a folder");
    expect(reason("weekly.md")).toBe("cost-templates is not a folder");
  });
});

// A swap between the checks and the read cannot be timed on a real filesystem, so these drive the fs
// calls the reader makes to the outcome a swap produces. Every spy is synchronous and restored before the
// test returns, so no other test in the process can see it.
describe("readCostTemplateFile: a swap between the checks and the read is refused", () => {
  const errno = (code: string): NodeJS.ErrnoException => {
    const e = new Error(code) as NodeJS.ErrnoException;
    e.code = code;
    return e;
  };
  function withSpy(spy: { mockRestore(): void }, f: () => void): void {
    try {
      f();
    } finally {
      spy.mockRestore();
    }
  }
  beforeEach(() => {
    writeFileSync(join(templates, "weekly.md"), "Checkout: {total}");
  });

  test("the file became a link before it was opened (O_NOFOLLOW's ELOOP)", () => {
    const spy = spyOn(fs, "openSync").mockImplementation(() => {
      throw errno("ELOOP");
    });
    withSpy(spy, () => {
      expect(reason("weekly.md")).toBe("the template file weekly.md is a link");
    });
  });

  test("any other open failure names its code", () => {
    const spy = spyOn(fs, "openSync").mockImplementation(() => {
      throw errno("EACCES");
    });
    withSpy(spy, () => {
      expect(reason("weekly.md")).toBe("could not open weekly.md: EACCES");
    });
  });

  test("the opened handle is not a regular file", () => {
    const real = fs.fstatSync;
    const spy = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const st = real(fd);
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, {
        isFile: () => false,
      });
    }) as typeof fs.fstatSync);
    withSpy(spy, () => {
      expect(reason("weekly.md")).toBe("the template file weekly.md is not a regular file");
    });
  });

  test("a file that shrank during the read yields only what was read", () => {
    const real = fs.readSync;
    let calls = 0;
    const spy = spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buf: NodeJS.ArrayBufferView,
      off: number,
      _len: number,
      pos: number,
    ) => {
      calls += 1;
      return calls === 1 ? real(fd, buf, off, 8, pos) : 0;
    }) as typeof fs.readSync);
    withSpy(spy, () => {
      expect(readCostTemplateFile(configDir, "weekly.md")).toBe("Checkout");
    });
  });

  /** lstat answers truly for the folder and file checks, then `after` for the check after the read. */
  function afterRead(after: (real: Stats) => Stats): { mockRestore(): void } {
    const real = fs.lstatSync;
    let calls = 0;
    return spyOn(fs, "lstatSync").mockImplementation(((p: string) => {
      calls += 1;
      const st = real(p);
      return calls <= 2 ? st : after(st);
    }) as typeof fs.lstatSync);
  }
  const variant = (st: Stats, over: Partial<Stats>): Stats =>
    Object.assign(Object.create(Object.getPrototypeOf(st) as object) as Stats, st, over);
  const CHANGED = "the template file weekly.md changed while it was read";

  test("the file was removed, became a link, or is another file after the read", () => {
    withSpy(
      afterRead(() => {
        throw errno("ENOENT");
      }),
      () => expect(reason("weekly.md")).toBe(CHANGED),
    );
    withSpy(
      afterRead((st) => variant(st, { isSymbolicLink: () => true })),
      () => expect(reason("weekly.md")).toBe(CHANGED),
    );
    withSpy(
      afterRead((st) => variant(st, { ino: st.ino + 1 })),
      () => expect(reason("weekly.md")).toBe(CHANGED),
    );
    withSpy(
      afterRead((st) => variant(st, { dev: st.dev + 1 })),
      () => expect(reason("weekly.md")).toBe(CHANGED),
    );
    // Unchanged: the same reader with a truthful lstat reads the file.
    withSpy(
      afterRead((st) => st),
      () => expect(readCostTemplateFile(configDir, "weekly.md")).toBe("Checkout: {total}"),
    );
  });
});

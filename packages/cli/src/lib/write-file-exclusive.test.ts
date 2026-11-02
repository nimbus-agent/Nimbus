import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleTempFiles, WriteFileError, writeFileExclusive } from "./write-file-exclusive.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-write-exclusive-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("writeFileExclusive", () => {
  test("creates a new file", () => {
    const p = join(dir, "a.txt");
    writeFileExclusive(p, bytes("one"));
    expect(readFileSync(p, "utf8")).toBe("one");
  });

  test("refuses an existing file and leaves it untouched", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    expect(() => writeFileExclusive(p, bytes("new"))).toThrow(/exists; refusing to overwrite it/);
    expect(readFileSync(p, "utf8")).toBe("old");
  });

  test("overwrite replaces an existing file", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "a much longer old body");
    writeFileExclusive(p, bytes("new"), { overwrite: true });
    expect(readFileSync(p, "utf8")).toBe("new");
  });

  test("a missing parent directory is a could-not-create error", () => {
    const p = join(dir, "missing", "a.txt");
    expect(() => writeFileExclusive(p, bytes("x"))).toThrow(WriteFileError);
    expect(() => writeFileExclusive(p, bytes("x"))).toThrow(/could not create .*: ENOENT/);
  });

  test("a write that fails after the create removes the file", () => {
    const p = join(dir, "a.txt");
    const writeFd = (): void => {
      throw Object.assign(new Error("disk"), { code: "ENOSPC" });
    };
    expect(() => writeFileExclusive(p, bytes("x"), { writeFd })).toThrow(
      /could not write .*: ENOSPC/,
    );
    expect(existsSync(p)).toBe(false);
  });

  test("a failed overwrite leaves the old file byte-identical and no temp file behind", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old body");
    const writeFd = (): void => {
      throw Object.assign(new Error("disk"), { code: "ENOSPC" });
    };
    expect(() => writeFileExclusive(p, bytes("new"), { overwrite: true, writeFd })).toThrow(
      /could not write .*: ENOSPC/,
    );
    expect(readFileSync(p, "utf8")).toBe("old body");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("a successful overwrite leaves only the target in the directory", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    writeFileExclusive(p, bytes("new"), { overwrite: true });
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });
});

describe("writeFileExclusive atomicity", () => {
  const failing = (): void => {
    throw Object.assign(new Error("disk"), { code: "ENOSPC" });
  };

  test("a failed write in either mode leaves no temp file", () => {
    const p = join(dir, "a.txt");
    expect(() => writeFileExclusive(p, bytes("x"), { writeFd: failing })).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(p, "old");
    expect(() => writeFileExclusive(p, bytes("x"), { overwrite: true, writeFd: failing })).toThrow(
      /ENOSPC/,
    );
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("the target appears only complete: the bytes are written to a temp file before it exists", () => {
    const p = join(dir, "a.txt");
    const seen: boolean[] = [];
    writeFileExclusive(p, bytes("whole"), {
      writeFd: (fd, data) => {
        seen.push(existsSync(p));
        writeFileSync(fd, data);
      },
    });
    expect(seen).toEqual([false]);
    expect(readFileSync(p, "utf8")).toBe("whole");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("no-overwrite mode publishes with a link: EEXIST keeps the old file and the old message", () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old");
    let linked = 0;
    const link = (existing: string, target: string): void => {
      linked += 1;
      linkSync(existing, target);
    };
    expect(() => writeFileExclusive(p, bytes("new"), { link })).toThrow(
      `${p} exists; refusing to overwrite it`,
    );
    expect(linked).toBe(1);
    expect(readFileSync(p, "utf8")).toBe("old");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("a target created between the write and the link is never replaced", () => {
    const p = join(dir, "a.txt");
    const link = (existing: string, target: string): void => {
      writeFileSync(target, "raced in");
      linkSync(existing, target);
    };
    expect(() => writeFileExclusive(p, bytes("new"), { link })).toThrow(/exists; refusing/);
    expect(readFileSync(p, "utf8")).toBe("raced in");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("a filesystem without hard links falls back to an exclusive create", () => {
    const p = join(dir, "a.txt");
    const link = (): void => {
      throw Object.assign(new Error("no links"), { code: "EPERM" });
    };
    writeFileExclusive(p, bytes("fallback"), { link });
    expect(readFileSync(p, "utf8")).toBe("fallback");
    expect(readdirSync(dir)).toEqual(["a.txt"]);
    expect(() => writeFileExclusive(p, bytes("again"), { link })).toThrow(/exists; refusing/);
    expect(readFileSync(p, "utf8")).toBe("fallback");
  });
});

describe("sweepStaleTempFiles", () => {
  test("removes only this target's temp files", () => {
    const p = join(dir, "golden.eval.json");
    const stale = ".golden.eval.json.0123456789ab.tmp";
    writeFileSync(join(dir, stale), "partial");
    for (const keep of [
      ".other.eval.json.0123456789ab.tmp",
      ".golden.eval.json.0123456789a.tmp",
      "golden.eval.json",
      ".golden.eval.json.0123456789ab.tmp.keep",
    ]) {
      writeFileSync(join(dir, keep), "keep");
    }
    sweepStaleTempFiles(p);
    expect(existsSync(join(dir, stale))).toBe(false);
    expect(readdirSync(dir).length).toBe(4);
  });

  test("a missing directory is not an error", () => {
    expect(() => sweepStaleTempFiles(join(dir, "nope", "a.json"))).not.toThrow();
  });
});

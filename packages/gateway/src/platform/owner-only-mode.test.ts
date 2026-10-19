import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOwnerOnlyFile, tightenToOwnerOnly } from "./owner-only-mode.ts";

const posix = process.platform !== "win32";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-owner-only-"));
  roots.push(d);
  return d;
}
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe("tightenToOwnerOnly", () => {
  test.skipIf(!posix)(
    "strips group/other bits from a file and a directory, keeping owner bits",
    () => {
      const root = tmp();
      const file = join(root, "f");
      writeFileSync(file, "x");
      chmodSync(file, 0o664);
      const dir = join(root, "d");
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      tightenToOwnerOnly(file);
      tightenToOwnerOnly(dir);
      expect(modeOf(file)).toBe(0o600);
      expect(modeOf(dir)).toBe(0o700);
    },
  );

  test("never throws for a missing path", () => {
    expect(() => tightenToOwnerOnly(join(tmp(), "absent"))).not.toThrow();
  });

  test("is a no-op on win32", () => {
    const file = join(tmp(), "f");
    writeFileSync(file, "x");
    if (posix) chmodSync(file, 0o644);
    const before = statSync(file).mode;
    tightenToOwnerOnly(file, "win32");
    expect(statSync(file).mode).toBe(before);
  });
});

describe("ensureOwnerOnlyFile", () => {
  test.skipIf(!posix)("creates a missing file 0600 and tightens an existing one", () => {
    const root = tmp();
    const fresh = join(root, "nimbus.db");
    ensureOwnerOnlyFile(fresh);
    expect(modeOf(fresh)).toBe(0o600);
    expect(statSync(fresh).size).toBe(0);

    const old = join(root, "old.db");
    writeFileSync(old, "data");
    chmodSync(old, 0o644);
    ensureOwnerOnlyFile(old);
    expect(modeOf(old)).toBe(0o600);
    // Existing content is never truncated.
    expect(statSync(old).size).toBe(4);
  });
});

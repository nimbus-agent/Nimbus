import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownershipRoots, resolveOwnershipPath } from "./ownership-target.ts";

const ROOTS = ["/repo/alpha", "/repo/beta"];
const onDisk = new Set(["/repo/alpha/src/a.ts", "/repo/alpha/src", "/repo/beta/lib/b.ts"]);
const exists = (p: string): boolean => onDisk.has(p.replaceAll("\\", "/"));

describe("resolveOwnershipPath", () => {
  test("resolves an absolute path inside a root", () => {
    expect(resolveOwnershipPath(ROOTS, "/repo/alpha/src/a.ts", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "src/a.ts",
    });
  });

  test("resolves a relative path against the root that contains it", () => {
    expect(resolveOwnershipPath(ROOTS, "lib/b.ts", exists)).toEqual({
      repoRoot: "/repo/beta",
      relPath: "lib/b.ts",
    });
  });

  test("resolves the root itself, which the shared why fence rejects", () => {
    // `matchConfiguredRoot` returns null when rel === "" — correct for `why`, whose
    // subject must be a file. The ownership graph HAS a root-directory node
    // (`dir:<root>:`), so this case must resolve here.
    expect(resolveOwnershipPath(ROOTS, "/repo/alpha", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "",
    });
  });

  test("resolves `.` to the first root", () => {
    expect(resolveOwnershipPath(ROOTS, ".", exists)).toEqual({
      repoRoot: "/repo/alpha",
      relPath: "",
    });
  });

  test("rejects a relative path that escapes its root", () => {
    expect(resolveOwnershipPath(ROOTS, "../outside/x.ts", exists)).toBeNull();
  });

  test("rejects an absolute path outside every root", () => {
    expect(resolveOwnershipPath(ROOTS, "/elsewhere/x.ts", exists)).toBeNull();
  });

  test("rejects a relative path that exists nowhere", () => {
    expect(resolveOwnershipPath(ROOTS, "src/gone.ts", exists)).toBeNull();
  });

  test("returns null when no roots are configured", () => {
    expect(resolveOwnershipPath([], "/repo/alpha/src/a.ts", exists)).toBeNull();
  });
});

test("ownershipRoots includes CLI-registered roots, not only TOML roots", () => {
  const configDir = mkdtempSync(join(tmpdir(), "nimbus-own-roots-"));
  const registered = mkdtempSync(join(tmpdir(), "nimbus-own-registered-"));
  try {
    mkdirSync(join(registered, ".git"), { recursive: true });

    // No [[filesystem.roots]] block at all — the ONLY root is a registered one.
    writeFileSync(join(configDir, "nimbus.toml"), "[ownership]\nenabled = true\n", "utf8");
    writeFileSync(
      join(configDir, "registered-roots.json"),
      `${JSON.stringify([registered], null, 2)}\n`,
      "utf8",
    );

    // A TOML-only reader returns []; the merged reader returns the registered root. The
    // pass blames this root, so a TOML-only reader would call every path under it unowned.
    expect(ownershipRoots(configDir)).toContain(registered);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(registered, { recursive: true, force: true });
  }
});

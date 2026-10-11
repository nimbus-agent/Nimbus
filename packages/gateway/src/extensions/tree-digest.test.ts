import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeExtensionTreeDigest } from "./tree-digest.ts";

const roots: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-tree-digest-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const BASE = {
  "nimbus.extension.json": '{"id":"x","version":"1.0.0"}',
  "dist/server.js": 'import "./chunk.js";',
  "dist/chunk.js": "export {};",
  "node_modules/dep/index.js": "module.exports = 1;",
};

describe("computeExtensionTreeDigest", () => {
  test("is a 64-char hex digest, identical for identical trees built separately", () => {
    const a = computeExtensionTreeDigest(tree(BASE));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(computeExtensionTreeDigest(tree(BASE))).toBe(a);
  });

  test("does not depend on the order files were created in", () => {
    const reversed = Object.fromEntries(Object.entries(BASE).reverse());
    expect(computeExtensionTreeDigest(tree(reversed))).toBe(computeExtensionTreeDigest(tree(BASE)));
  });

  test("changes when a SIBLING module changes — the bytes manifest_hash + entry_hash never covered", () => {
    const before = computeExtensionTreeDigest(tree(BASE));
    const after = computeExtensionTreeDigest(tree({ ...BASE, "dist/chunk.js": "steal();" }));
    expect(after).not.toBe(before);
  });

  test("changes when a node_modules file changes", () => {
    const before = computeExtensionTreeDigest(tree(BASE));
    const after = computeExtensionTreeDigest(
      tree({ ...BASE, "node_modules/dep/index.js": "module.exports = 2;" }),
    );
    expect(after).not.toBe(before);
  });

  test("changes when a file is added or removed", () => {
    const base = computeExtensionTreeDigest(tree(BASE));
    expect(computeExtensionTreeDigest(tree({ ...BASE, "dist/extra.js": "" }))).not.toBe(base);
    const removed = tree(BASE);
    unlinkSync(join(removed, "dist", "chunk.js"));
    expect(computeExtensionTreeDigest(removed)).not.toBe(base);
  });

  test("changes when a file MOVES, even with identical bytes", () => {
    const moved = { ...BASE } as Record<string, string>;
    delete moved["dist/chunk.js"];
    moved["dist/sub/chunk.js"] = "export {};";
    expect(computeExtensionTreeDigest(tree(moved))).not.toBe(
      computeExtensionTreeDigest(tree(BASE)),
    );
  });

  test("an empty directory does not change the digest", () => {
    const withDir = tree(BASE);
    mkdirSync(join(withDir, "empty"));
    expect(computeExtensionTreeDigest(withDir)).toBe(computeExtensionTreeDigest(tree(BASE)));
  });

  test.skipIf(process.platform === "win32")(
    "THROWS on a symlink rather than following or skipping it",
    () => {
      // Windows symlink creation needs a privilege CI runners do not grant; the refusal is the same
      // lstat check on every OS.
      const root = tree(BASE);
      symlinkSync(join(root, "dist", "chunk.js"), join(root, "dist", "link.js"));
      expect(() => computeExtensionTreeDigest(root)).toThrow(/symlink/);
    },
  );

  test.skipIf(process.platform === "win32")("THROWS on a non-regular file (a FIFO)", () => {
    // A FIFO, socket or device is neither a file whose bytes can be hashed nor a directory to walk.
    const root = tree(BASE);
    const fifo = join(root, "dist", "pipe");
    const made = spawnSync("mkfifo", [fifo]);
    expect(made.status).toBe(0);
    expect(() => computeExtensionTreeDigest(root)).toThrow(/non-regular file/);
  });
});

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  extensionSlug,
  extensionVersionsRoot,
  newestPrevVersion,
  pendingDir,
  prevVersionDir,
  removeExtensionVersionStore,
} from "./version-store.ts";

describe("version-store", () => {
  it("slug is 16 hex and differs for acme/foo vs acme-foo", () => {
    const a = extensionSlug("acme/foo");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(extensionSlug("acme-foo"));
  });

  it("versions root is a sibling of extensionsDir", () => {
    const ext = join(tmpdir(), "x", "extensions");
    expect(extensionVersionsRoot(ext)).toBe(join(dirname(ext), "extension-versions"));
    expect(pendingDir(ext, "a", "1.0.0").startsWith(extensionVersionsRoot(ext))).toBe(true);
  });

  it("newestPrevVersion picks 1.10.0 over 1.9.0", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-vstore-"));
    try {
      const ext = join(root, "extensions");
      for (const v of ["1.9.0", "1.10.0"]) {
        mkdirSync(prevVersionDir(ext, "acme/foo", v), { recursive: true });
      }
      expect(newestPrevVersion(ext, "acme/foo")).toBe("1.10.0");
      removeExtensionVersionStore(ext, "acme/foo");
      expect(newestPrevVersion(ext, "acme/foo")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("newestPrevVersion ignores a non-semver directory", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-vstore-"));
    try {
      const ext = join(root, "extensions");
      mkdirSync(prevVersionDir(ext, "a", "latest"), { recursive: true });
      expect(newestPrevVersion(ext, "a")).toBeUndefined();
      mkdirSync(prevVersionDir(ext, "a", "0.2.0"), { recursive: true });
      expect(newestPrevVersion(ext, "a")).toBe("0.2.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NIMBUS_VERSION } from "./version.ts";

describe("NIMBUS_VERSION", () => {
  it("is a non-empty semver-shaped string", () => {
    expect(NIMBUS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("matches the monorepo root package.json version (release-please source of truth)", () => {
    const rootPkgPath = join(import.meta.dir, "..", "..", "..", "package.json");
    const rootVersion = JSON.parse(readFileSync(rootPkgPath, "utf8")).version as string;
    expect(NIMBUS_VERSION).toBe(rootVersion);
  });
});

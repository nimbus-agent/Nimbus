import { describe, expect, it } from "bun:test";
import { join, resolve, sep } from "node:path";
import { assertWithinResultsDir } from "../src/gx-parse.ts";

/**
 * Filesystem analog of the argv flag-smuggling guard: the MCP server only reads
 * files within the configured GREAT_EXPECTATIONS_RESULTS_DIR. A `..`-escaping or
 * absolute path that resolves outside the dir must be rejected.
 */
describe("Great Expectations path-traversal guard", () => {
  const root = resolve(sep, "gx", "results");

  it("allows the dir itself and descendants", () => {
    expect(() => assertWithinResultsDir(root, root)).not.toThrow();
    expect(() => assertWithinResultsDir(join(root, "validations", "a.json"), root)).not.toThrow();
    expect(() =>
      assertWithinResultsDir(join(root, "nested", "deep", "b.json"), root),
    ).not.toThrow();
  });

  it("rejects a path that escapes the results dir via ..", () => {
    expect(() => assertWithinResultsDir(resolve(root, "..", "etc", "passwd"), root)).toThrow();
    expect(() => assertWithinResultsDir(resolve(sep, "etc", "passwd"), root)).toThrow();
  });
});

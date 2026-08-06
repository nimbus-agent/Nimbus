import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { EMBEDDED_CONSOLE_ASSETS, EMBEDDED_OPENAPI_YAML } from "./embedded-assets.ts";

describe("embedded assets", () => {
  test("the console map holds exactly the three build outputs", () => {
    expect(Object.keys(EMBEDDED_CONSOLE_ASSETS).sort((a, b) => a.localeCompare(b))).toEqual([
      "index.html",
      "main.js",
      "styles.css",
    ]);
  });

  test("every console asset resolves to a readable, non-empty file", () => {
    for (const path of Object.values(EMBEDDED_CONSOLE_ASSETS)) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path).byteLength).toBeGreaterThan(0);
    }
  });

  test("the OpenAPI document resolves to a readable YAML file", () => {
    expect(existsSync(EMBEDDED_OPENAPI_YAML)).toBe(true);
    expect(readFileSync(EMBEDDED_OPENAPI_YAML, "utf8")).toContain("openapi:");
  });

  test("the console map is frozen", () => {
    expect(Object.isFrozen(EMBEDDED_CONSOLE_ASSETS)).toBe(true);
  });
});

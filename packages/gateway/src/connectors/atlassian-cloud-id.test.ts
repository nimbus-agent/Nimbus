import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isAtlassianCloudId } from "./atlassian-cloud-id.ts";
import { installedConnectorsPackageRoot } from "./testing/connector-write-registrations.ts";

const LOWER = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

describe("isAtlassianCloudId (the connector's CLOUD_ID_PATTERN, ^[0-9a-f-]{36}$ case-insensitive)", () => {
  test("accepts a lowercase and an uppercase UUID", () => {
    expect(isAtlassianCloudId(LOWER)).toBe(true);
    expect(isAtlassianCloudId(LOWER.toUpperCase())).toBe(true);
  });

  test("refuses empty, 35 and 37 characters", () => {
    expect(isAtlassianCloudId("")).toBe(false);
    expect(isAtlassianCloudId(LOWER.slice(1))).toBe(false);
    expect(isAtlassianCloudId(`${LOWER}0`)).toBe(false);
  });

  test("refuses a path, a trailing slash or newline, padding, and a non-hex letter", () => {
    expect(isAtlassianCloudId("../x")).toBe(false);
    expect(isAtlassianCloudId(`${LOWER}/`)).toBe(false);
    expect(isAtlassianCloudId(`${LOWER.slice(1)}\n`)).toBe(false);
    expect(isAtlassianCloudId(` ${LOWER.slice(1)}`)).toBe(false);
    expect(isAtlassianCloudId(`${LOWER.slice(0, 35)}g`)).toBe(false);
    expect(isAtlassianCloudId(`${LOWER.slice(0, 35)}٠`)).toBe(false);
  });

  test("a huge value is refused by its length without scanning it", () => {
    expect(isAtlassianCloudId("a".repeat(1_000_000))).toBe(false);
  });

  test("the installed connector source still carries the same pattern", () => {
    const text = readFileSync(
      join(installedConnectorsPackageRoot(), "connectors", "jira", "src", "tools.ts"),
      "utf8",
    );
    expect(text).toMatch(/CLOUD_ID_PATTERN\s*=\s*\/\^\[0-9a-f-\]\{36\}\$\/i/);
  });
});

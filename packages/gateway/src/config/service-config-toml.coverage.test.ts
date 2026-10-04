/**
 * service-config-toml.coverage.test.ts — the arms of service-config-toml.ts the main suite leaves
 * open: the `[metrics.dora.*]` file loaders, a service table declared twice (one bucket, keys
 * merged), and a key-less line inside a table.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadNimbusDoraFromConfigDir,
  loadNimbusDoraFromPath,
  parseNimbusDoraToml,
} from "./service-config-toml.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configDir(body?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-service-config-cov-"));
  tempDirs.push(dir);
  if (body !== undefined) writeFileSync(join(dir, "nimbus.toml"), body, "utf8");
  return dir;
}

describe("loadNimbusDoraFromPath / loadNimbusDoraFromConfigDir", () => {
  test("a missing file yields no services", () => {
    const dir = configDir();
    expect(loadNimbusDoraFromPath(join(dir, "nimbus.toml")).size).toBe(0);
    expect(loadNimbusDoraFromConfigDir(dir).size).toBe(0);
  });

  test("an existing file is parsed from <configDir>/nimbus.toml", () => {
    const dir = configDir(
      '[metrics.dora.checkout]\nrepos = ["github:acme/checkout"]\nincident_window_minutes = 45\n',
    );
    const byDir = loadNimbusDoraFromConfigDir(dir);
    expect([...byDir.keys()]).toEqual(["checkout"]);
    expect(byDir.get("checkout")?.incidentWindowMinutes).toBe(45);
    expect(loadNimbusDoraFromPath(join(dir, "nimbus.toml")).get("checkout")?.repos).toEqual(
      byDir.get("checkout")?.repos,
    );
  });
});

describe("parseNimbusDoraToml — table accumulation", () => {
  test("a service table declared twice is ONE service with both blocks' keys", () => {
    const parsed = parseNimbusDoraToml(
      [
        "[metrics.dora.checkout]",
        'repos = ["github:acme/checkout"]',
        "[metrics.dora.payments]",
        'repos = ["github:acme/payments"]',
        "[metrics.dora.checkout]",
        'pagerduty_services = ["PCHK1"]',
      ].join("\n"),
    );
    expect([...parsed.keys()]).toEqual(["checkout", "payments"]);
    const checkout = parsed.get("checkout");
    expect(checkout?.repos.map((r) => `${r.provider}:${r.providerId}`)).toEqual([
      "github:acme/checkout",
    ]);
    expect(checkout?.pagerdutyServices).toEqual(["PCHK1"]);
  });

  test("a line with no `=` inside a service table is ignored, not an unknown-key error", () => {
    const parsed = parseNimbusDoraToml(
      '[metrics.dora.checkout]\nrepos = ["github:acme/checkout"]\njust some words\n',
    );
    expect(parsed.get("checkout")?.serviceId).toBe("checkout");
  });
});

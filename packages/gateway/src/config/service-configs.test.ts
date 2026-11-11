import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadServiceConfigsOrEmpty } from "./service-configs.ts";

describe("loadServiceConfigsOrEmpty", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-svc-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a valid dir returns the configs", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[ci.service.payments]\nrepos = ["github:acme/payments"]\npagerduty_services = ["P1"]\n`,
      "utf8",
    );
    const warnings: string[] = [];
    const out = loadServiceConfigsOrEmpty(dir, (m) => warnings.push(m));
    expect(out.map((c) => c.serviceId)).toEqual(["payments"]);
    expect(out[0]?.pagerdutyServices).toEqual(["P1"]);
    expect(warnings).toEqual([]);
  });

  test("a malformed block returns [] and warns instead of throwing", () => {
    writeFileSync(join(dir, "nimbus.toml"), `[ci.service.]\nrepos = []\n`, "utf8");
    const warnings: string[] = [];
    expect(loadServiceConfigsOrEmpty(dir, (m) => warnings.push(m))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("service names will not resolve");
  });

  test("no config dir returns []", () => {
    expect(loadServiceConfigsOrEmpty(undefined, () => {})).toEqual([]);
  });
});

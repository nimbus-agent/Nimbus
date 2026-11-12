import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NO_INCIDENT_BINDINGS } from "../metrics/dora-config.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "./nimbus-toml.ts";
import { parseNimbusCiServiceToml, parseNimbusDoraToml } from "./service-config-toml.ts";

const BLOCKS = [
  { header: "metrics.dora", parse: parseNimbusDoraToml },
  { header: "ci.service", parse: parseNimbusCiServiceToml },
] as const;

function table(header: string, body: string, id = "payments"): string {
  return `[${header}.${id}]\nrepos = ["github:acme/payments"]\n${body}\n`;
}

for (const { header, parse } of BLOCKS) {
  describe(`[${header}.<id>] incident-engine bindings`, () => {
    test("the four keys parse to the four fields", () => {
      const cfg = parse(
        table(
          header,
          [
            'jsm_alert_tags = ["Payments", "prod-db"]',
            'sentry_projects = ["payments-api", "payments_worker"]',
            'data_models = ["Analytics.Payments.*", "*.orders"]',
            'depends_on = ["ledger", "auth"]',
          ].join("\n"),
        ),
      ).get("payments");
      expect(cfg?.jsmAlertTags).toEqual(["Payments", "prod-db"]);
      expect(cfg?.sentryProjects).toEqual(["payments-api", "payments_worker"]);
      // Globs are lower-cased at parse time.
      expect(cfg?.dataModels).toEqual(["analytics.payments.*", "*.orders"]);
      expect(cfg?.dependsOn).toEqual(["ledger", "auth"]);
    });

    test("absent keys default to empty arrays", () => {
      const cfg = parse(table(header, "")).get("payments");
      expect(cfg?.jsmAlertTags).toEqual([]);
      expect(cfg?.sentryProjects).toEqual([]);
      expect(cfg?.dataModels).toEqual([]);
      expect(cfg?.dependsOn).toEqual([]);
      expect(cfg).toMatchObject(NO_INCIDENT_BINDINGS);
    });

    const bad: [string, string, RegExp][] = [
      ["an empty (whitespace) entry", 'jsm_alert_tags = ["ok", "   "]', /jsm_alert_tags has an empty entry/],
      ["a too-long jsm tag", `jsm_alert_tags = ["${"x".repeat(129)}"]`, /jsm_alert_tags entry is longer/],
      ["a Sentry slug with a capital", 'sentry_projects = ["Payments"]', /sentry_projects entry 'Payments'/],
      ["a Sentry slug with a space", 'sentry_projects = ["pay ments"]', /sentry_projects entry/],
      ["a glob that is only stars", 'data_models = ["***"]', /must contain a non-'\*' character/],
      ["a glob with whitespace", 'data_models = ["a b"]', /no whitespace/],
      ["a glob over 200 characters", `data_models = ["${"a".repeat(201)}"]`, /at most 200 characters/],
      ["depends_on naming the service itself", 'depends_on = ["payments"]', /must not name the service itself/],
      [
        "more than 50 entries",
        `depends_on = [${Array.from({ length: 51 }, (_, i) => `"s${String(i)}"`).join(", ")}]`,
        /depends_on has more than 50 entries/,
      ],
    ];
    for (const [name, body, message] of bad) {
      test(`${name} throws with the [${header}.id].key prefix`, () => {
        expect(() => parse(table(header, body))).toThrow(message);
        expect(() => parse(table(header, body))).toThrow(`[${header}.payments]`);
      });
    }

    test("an unknown key still throws", () => {
      expect(() => parse(table(header, 'owner_team = ["x"]'))).toThrow(/unknown key 'owner_team'/);
    });

    test("a malformed array throws and repos stays required", () => {
      expect(() => parse(table(header, 'depends_on = "ledger"'))).toThrow();
      expect(() => parse(`[${header}.payments]\njsm_alert_tags = ["a"]\n`)).toThrow(
        /missing required 'repos'/,
      );
    });
  });
}

describe("the merged loader", () => {
  let dir: string;
  let stderr: string[];
  let realWrite: typeof process.stderr.write;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-bindings-"));
    mkdirSync(dir, { recursive: true });
    stderr = [];
    realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realWrite;
    rmSync(dir, { recursive: true, force: true });
  });

  function load(toml: string): ReturnType<typeof loadNimbusServiceConfigsFromConfigDir> {
    writeFileSync(join(dir, "nimbus.toml"), toml);
    return loadNimbusServiceConfigsFromConfigDir(dir);
  }

  test("a depends_on target that is not configured warns once and does not throw", () => {
    const merged = load(
      `${table("ci.service", 'depends_on = ["ledger", "ghost"]')}\n${table("ci.service", "", "ledger")}`,
    );
    expect(merged.get("payments")?.dependsOn).toEqual(["ledger", "ghost"]);
    const warnings = stderr.filter((l) => l.includes("depends_on"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[payments]");
    expect(warnings[0]).toContain("'ghost'");
  });

  test("a configured target does not warn", () => {
    load(`${table("ci.service", 'depends_on = ["ledger"]')}\n${table("metrics.dora", "", "ledger")}`);
    expect(stderr.filter((l) => l.includes("depends_on"))).toEqual([]);
  });

  test("[ci.service] overriding [metrics.dora] keeps the ci fields", () => {
    const merged = load(
      `${table("metrics.dora", 'jsm_alert_tags = ["old"]')}\n${table("ci.service", 'jsm_alert_tags = ["new"]\nsentry_projects = ["p1"]')}`,
    );
    expect(merged.get("payments")?.jsmAlertTags).toEqual(["new"]);
    expect(merged.get("payments")?.sentryProjects).toEqual(["p1"]);
  });
});

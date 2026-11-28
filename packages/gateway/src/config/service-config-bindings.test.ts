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

    test("chat_aliases parses, and absent reads empty", () => {
      const cfg = parse(table(header, 'chat_aliases = ["checkout", "web-checkout"]')).get(
        "payments",
      );
      expect(cfg?.chatAliases).toEqual(["checkout", "web-checkout"]);
      expect(parse(table(header, "")).get("payments")?.chatAliases).toEqual([]);
    });

    test("argocd_apps parses (IC5a), absent reads empty, and a bad name is refused", () => {
      const cfg = parse(table(header, 'argocd_apps = ["payments-api", "payments.worker"]')).get(
        "payments",
      );
      expect(cfg?.argocdApps).toEqual(["payments-api", "payments.worker"]);
      expect(parse(table(header, "")).get("payments")?.argocdApps).toEqual([]);
      expect(() => parse(table(header, 'argocd_apps = ["Payments API"]'))).toThrow(
        /argocd_apps entry 'Payments API' is not an Argo CD application name/,
      );
    });

    test("feature_flags parses all four services, project and flag forms; absent reads empty", () => {
      const cfg = parse(
        table(
          header,
          'feature_flags = ["launchdarkly:web", "launchdarkly:web:new-ui", "unleash:p", "split:ws:f", "flagsmith:p"]',
        ),
      ).get("payments");
      expect(cfg?.featureFlags).toEqual([
        { service: "launchdarkly", project: "web", flag: null },
        { service: "launchdarkly", project: "web", flag: "new-ui" },
        { service: "unleash", project: "p", flag: null },
        { service: "split", project: "ws", flag: "f" },
        { service: "flagsmith", project: "p", flag: null },
      ]);
      expect(parse(table(header, "")).get("payments")?.featureFlags).toEqual([]);
    });

    test.each([
      ["an unknown service", 'feature_flags = ["optimizely:web"]'],
      ["an empty project", 'feature_flags = ["launchdarkly:"]'],
      ["no project", 'feature_flags = ["launchdarkly"]'],
      ["an empty flag", 'feature_flags = ["launchdarkly:web:"]'],
      ["a fourth part", 'feature_flags = ["launchdarkly:web:f:x"]'],
    ])("feature_flags refuses %s", (_name, body) => {
      expect(() => parse(table(header, body))).toThrow(/feature_flags entry/);
    });

    test("a comma inside a quoted chat alias is part of the alias", () => {
      const cfg = parse(table(header, 'chat_aliases = ["checkout,prod", "web"]')).get("payments");
      expect(cfg?.chatAliases).toEqual(["checkout,prod", "web"]);
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
      [
        "an empty (whitespace) entry",
        'jsm_alert_tags = ["ok", "   "]',
        /jsm_alert_tags has an empty entry/,
      ],
      [
        "a too-long jsm tag",
        `jsm_alert_tags = ["${"x".repeat(129)}"]`,
        /jsm_alert_tags entry is longer/,
      ],
      [
        "a Sentry slug with a capital",
        'sentry_projects = ["Payments"]',
        /sentry_projects entry 'Payments'/,
      ],
      ["a Sentry slug with a space", 'sentry_projects = ["pay ments"]', /sentry_projects entry/],
      ["a glob that is only stars", 'data_models = ["***"]', /must contain a non-'\*' character/],
      ["a glob with whitespace", 'data_models = ["a b"]', /no whitespace/],
      [
        "a glob over 200 characters",
        `data_models = ["${"a".repeat(201)}"]`,
        /at most 200 characters/,
      ],
      ["an empty chat alias", 'chat_aliases = ["abc", "   "]', /chat_aliases has an empty entry/],
      ["a too-short chat alias", 'chat_aliases = ["ab"]', /chat_aliases entry must be 3 to 64/],
      [
        "a too-long chat alias",
        `chat_aliases = ["${"a".repeat(65)}"]`,
        /chat_aliases entry must be 3 to 64/,
      ],
      [
        "a chat alias with a control character",
        'chat_aliases = ["ab\u0007c"]',
        /control character or line break/,
      ],
      [
        "more than 50 chat aliases",
        `chat_aliases = [${Array.from({ length: 51 }, (_, i) => `"alias${String(i)}"`).join(", ")}]`,
        /chat_aliases has more than 50 entries/,
      ],
      [
        "depends_on naming the service itself",
        'depends_on = ["payments"]',
        /must not name the service itself/,
      ],
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
    load(
      `${table("ci.service", 'depends_on = ["ledger"]')}\n${table("metrics.dora", "", "ledger")}`,
    );
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

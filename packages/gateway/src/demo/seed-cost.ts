import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type ImportReport, importFocusPath } from "../finops/cost-import.ts";

/**
 * The demo organisation's cost (Phase 7, the Cost Pack): 30 days of synthetic FOCUS lines for the fictional
 * Acme org, written as a FOCUS CSV into the demo root and loaded through the SAME `importFocusPath` a real
 * `nimbus cost import` uses, so the demo exercises the real parser, reconciliation and store.
 *
 * Three products (`checkout`, `search`, `internal-tools`), envs `prod`, `dev` and `ci`, USD only, one untagged
 * line a day (it lands in `unassigned`, so the share is visible), and a spike on checkout's `payment-service`
 * compute over the last two days (the day of the story deploy). The rules below are written into the demo
 * `nimbus.toml` by the seed.
 */
export const DEMO_COST_TOML =
  "\n# Demo cost allocation (Phase 7): tagged lines map to their product and env, and to a service when tagged.\n" +
  "[[cost.rule]]\n" +
  'match = { tag = { product = "*", service = "*" } }\n' +
  'set = { product = "{tag.product}", env = "{tag.env}", service = "{tag.service}" }\n' +
  "\n" +
  "[[cost.rule]]\n" +
  'match = { tag = { product = "*" } }\n' +
  'set = { product = "{tag.product}", env = "{tag.env}" }\n';

export const DEMO_COST_DAYS = 30;
const DAY_MS = 86_400_000;
const ACCOUNT = "123456789012";
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,BillingPeriodStart,ChargePeriodStart,ProviderName,ServiceName,SubAccountId,SubAccountName,RegionId,Tags";

type DemoCostLine = {
  readonly service: string;
  readonly perDay: number;
  /** The amount on the last two days instead (the spike). */
  readonly spike?: number;
  readonly sub: [string, string];
  readonly tags: Readonly<Record<string, string>>;
};

const LINES: readonly DemoCostLine[] = [
  {
    service: "Amazon Elastic Compute Cloud",
    perDay: 120,
    spike: 380,
    sub: ["210000000001", "acme-prod"],
    tags: { product: "checkout", env: "prod", service: "payment-service" },
  },
  {
    service: "Amazon Relational Database Service",
    perDay: 60,
    sub: ["210000000001", "acme-prod"],
    tags: { product: "checkout", env: "prod", service: "payment-service" },
  },
  {
    service: "Amazon CloudFront",
    perDay: 25,
    sub: ["210000000001", "acme-prod"],
    tags: { product: "checkout", env: "prod", service: "checkout-web" },
  },
  {
    service: "Amazon OpenSearch Service",
    perDay: 80,
    sub: ["210000000001", "acme-prod"],
    tags: { product: "search", env: "prod" },
  },
  {
    service: "AWS Lambda",
    perDay: 6,
    sub: ["210000000001", "acme-prod"],
    tags: { product: "internal-tools", env: "prod" },
  },
  {
    service: "Amazon Elastic Compute Cloud",
    perDay: 15,
    sub: ["210000000002", "acme-dev"],
    tags: { product: "checkout", env: "dev" },
  },
  {
    service: "AWS CodeBuild",
    perDay: 9,
    sub: ["210000000003", "acme-ci"],
    tags: { product: "internal-tools", env: "ci" },
  },
  { service: "AWS Data Transfer", perDay: 3, sub: ["210000000001", "acme-prod"], tags: {} },
];

const csvTags = (tags: Readonly<Record<string, string>>): string =>
  Object.keys(tags).length === 0 ? "" : `"${JSON.stringify(tags).replaceAll('"', '""')}"`;

/** The demo FOCUS export: one row per line per day, the 30 UTC days ending on `nowMs`'s day. */
export function demoFocusCsv(nowMs: number): string {
  const today = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  const rows = [HEADER];
  for (let i = DEMO_COST_DAYS - 1; i >= 0; i--) {
    const day = new Date(today - i * DAY_MS).toISOString();
    const periodStart = `${day.slice(0, 8)}01T00:00:00Z`;
    for (const l of LINES) {
      const amount = l.spike !== undefined && i < 2 ? l.spike : l.perDay;
      rows.push(
        [
          amount.toFixed(2),
          ACCOUNT,
          "USD",
          periodStart,
          `${day.slice(0, 10)}T00:00:00Z`,
          "AWS",
          l.service,
          l.sub[0],
          l.sub[1],
          "us-east-1",
          csvTags(l.tags),
        ].join(","),
      );
    }
  }
  return `${rows.join("\n")}\n`;
}

/** Write the demo export under `<demoRoot>/cost/` and import it. Throws if any file is refused. */
export function seedDemoCost(db: Database, demoRoot: string, nowMs: number): ImportReport {
  const dir = join(demoRoot, "cost");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "acme-focus.csv");
  writeFileSync(path, demoFocusCsv(nowMs));
  const report = importFocusPath(db, path, { dryRun: false, now: () => nowMs });
  const refused = report.files.find((f) => f.status === "refused");
  if (refused !== undefined)
    throw new Error(`demo seed: the demo cost export was refused: ${refused.error ?? ""}`);
  return report;
}

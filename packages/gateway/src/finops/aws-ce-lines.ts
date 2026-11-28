// Phase 7 (the Cost Pack, slice 11b; owner ruling D7): AWS Cost Explorer results as cost lines. Pure (static D48:
// no network, no connector, no model import).
//
// `aws ce get-cost-and-usage --granularity DAILY --metrics UnblendedCost AmortizedCost UsageQuantity` grouped by
// SERVICE and LINKED_ACCOUNT answers `ResultsByTime[]`, each `{ TimePeriod: { Start, End }, Estimated, Groups: [
// { Keys: [service, linkedAccount], Metrics: { <metric>: { Amount, Unit } } } ] }`
// (https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostAndUsage.html).
//
// A line carries `billedCost` = UnblendedCost and `effectiveCost` = AmortizedCost, the linked account as its
// sub-account and the service name. `UsageQuantity` is read for nothing: its unit differs per service (hours,
// GB-months, requests), so a quantity of it would be a sum of unlike things and is NOT stored. There is no
// region, resource or tag grain (the API's two-group-by limit); a line is the day, the service and the account.
//
// A group the response cannot be read from (no keys, an amount that is not a finite number, a currency that is not
// a three-letter code, two currencies in one group, a day outside the month) is COUNTED in `skipped`, never
// guessed; the sync then writes nothing for that month. A group of 0 and 0 is dropped (Cost Explorer lists every
// service an account ever used). A repeated (day, service, account) keeps its first row.
import type { CostLine } from "./cost-line.ts";

export const AWS_CE_SOURCE = "aws_billing";
export const AWS_CE_PROVIDER = "aws";

export interface AwsCeLinesResult {
  readonly lines: readonly CostLine[];
  /** The days the response covers (`YYYY-MM-DD`): a day listed with no cost group replaces that day's lines. */
  readonly days: ReadonlySet<string>;
  /** True when any result is marked `Estimated`: AWS may still restate it, so the month stays pending. */
  readonly estimated: boolean;
  readonly skipped: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

function rec(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function metric(
  metrics: Record<string, unknown> | undefined,
  name: string,
): { amount: number; unit: string } | null {
  const m = rec(metrics?.[name]);
  const raw = m?.["Amount"];
  const unit = m?.["Unit"];
  if (typeof raw !== "string" || raw.trim() === "" || typeof unit !== "string") return null;
  const amount = Number(raw);
  return Number.isFinite(amount) ? { amount, unit } : null;
}

export function awsCeLines(
  account: string,
  month: string,
  results: readonly unknown[],
  importId: string,
): AwsCeLinesResult {
  const lines = new Map<string, CostLine>();
  const days = new Set<string>();
  let estimated = false;
  let skipped = 0;
  for (const result of results) {
    const r = rec(result);
    const day = ((): string | null => {
      const start = rec(r?.["TimePeriod"])?.["Start"];
      return typeof start === "string" && DAY_RE.test(start) && start.startsWith(month)
        ? start
        : null;
    })();
    const groups = r?.["Groups"];
    if (r === undefined || day === null || (groups !== undefined && !Array.isArray(groups))) {
      skipped++;
      continue;
    }
    days.add(day);
    if (r["Estimated"] === true) estimated = true;
    for (const g of (groups ?? []) as unknown[]) {
      const group = rec(g);
      const keys = group?.["Keys"];
      const service = Array.isArray(keys) ? keys[0] : undefined;
      const linked = Array.isArray(keys) ? keys[1] : undefined;
      const metrics = rec(group?.["Metrics"]);
      const billed = metric(metrics, "UnblendedCost");
      const effective = metric(metrics, "AmortizedCost");
      if (
        typeof service !== "string" ||
        service === "" ||
        typeof linked !== "string" ||
        linked === "" ||
        billed === null ||
        effective === null ||
        billed.unit !== effective.unit ||
        !CURRENCY_RE.test(billed.unit)
      ) {
        skipped++;
        continue;
      }
      if (billed.amount === 0 && effective.amount === 0) continue;
      const key = `${day}\u0000${service}\u0000${linked}`;
      if (lines.has(key)) continue;
      lines.set(key, {
        source: AWS_CE_SOURCE,
        provider: AWS_CE_PROVIDER,
        billingAccountId: account,
        billingPeriod: month,
        chargeDay: day,
        subAccountId: linked,
        subAccountName: null,
        serviceName: service,
        serviceCategory: null,
        regionId: null,
        resourceId: null,
        resourceName: null,
        skuId: null,
        chargeCategory: "usage",
        billedCost: billed.amount,
        effectiveCost: effective.amount,
        currency: billed.unit,
        tags: {},
        repo: null,
        workflow: null,
        model: null,
        importId,
      });
    }
  }
  return { lines: [...lines.values()], days, estimated, skipped };
}

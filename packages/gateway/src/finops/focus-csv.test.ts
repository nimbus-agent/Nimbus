import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { FocusCsvError, parseCsv, parseFocusCsv } from "./focus-csv.ts";

const FIXTURES = join(import.meta.dir, "__fixtures__", "focus");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const HEADER =
  "BilledCost,BillingAccountId,BillingAccountName,BillingCurrency,BillingPeriodStart,BillingPeriodEnd,ChargeCategory,ChargePeriodStart,ChargePeriodEnd,EffectiveCost,ProviderName,RegionId,ResourceId,ResourceName,ServiceCategory,ServiceName,SkuId,SubAccountId,SubAccountName,Tags";
const row = (fields: Partial<Record<string, string>>): string =>
  HEADER.split(",")
    .map((h) => fields[h] ?? "")
    .join(",");
const BASE = {
  BilledCost: "1",
  BillingAccountId: "111",
  BillingCurrency: "USD",
  ChargePeriodStart: "2026-11-01T00:00:00Z",
  ProviderName: "AWS",
  ServiceName: "S3",
};

describe("parseCsv (RFC 4180, no dependency)", () => {
  test("quotes, doubled quotes, embedded commas and newlines", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nbye"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"\nbye'],
    ]);
  });

  test("a BOM is stripped and CRLF equals LF", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual(parseCsv("a,b\n1,2\n"));
  });

  test("a final line without a newline and empty fields", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });

  test("an unterminated quote is an error", () => {
    expect(() => parseCsv('a\n"open')).toThrow(FocusCsvError);
  });
});

describe("parseFocusCsv", () => {
  test("the AWS sample: hourly rows of one grain aggregate into a day; totals reconcile", () => {
    const r = parseFocusCsv(fixture("aws.csv"), { importId: "imp" });
    expect(r.skipped).toEqual([]);
    expect(r.lines).toHaveLength(3);
    const s3 = r.lines.find((l) => l.serviceName === "Amazon Simple Storage Service");
    expect(s3).toMatchObject({
      source: "focus",
      provider: "aws",
      billingAccountId: "111111111111",
      billingPeriod: "2026-11",
      chargeDay: "2026-11-01",
      subAccountId: "222222222222",
      subAccountName: "web-prod",
      regionId: "us-east-1",
      resourceId: "arn:aws:s3:::acme-web",
      skuId: "S3-STD",
      chargeCategory: "usage",
      billedCost: 15,
      effectiveCost: 13,
      currency: "USD",
      tags: { env: "prod", product: "checkout" },
      importId: "imp",
    });
    const ec2 = r.lines.find((l) => l.serviceName === "Amazon Elastic Compute Cloud");
    expect(ec2?.effectiveCost).toBeNull();
    const credit = r.lines.find((l) => l.chargeCategory === "credit");
    expect(credit?.billedCost).toBe(-5);
    const period = r.byPeriod.get("aws|111111111111|2026-11");
    expect(period?.key).toEqual({
      source: "focus",
      provider: "aws",
      billingAccountId: "111111111111",
      billingPeriod: "2026-11",
    });
    expect([...(period?.days ?? [])].sort()).toEqual(["2026-11-01", "2026-11-02"]);
    expect(period?.totals.get("USD")).toBe(50);
    const lineSum = r.lines.reduce((a, l) => a + l.billedCost, 0);
    expect(lineSum).toBe(50);
  });

  test("the Azure and Google Cloud samples infer their provider", () => {
    const az = parseFocusCsv(fixture("azure.csv"), { importId: "i" });
    expect(az.lines[0]).toMatchObject({
      provider: "azure",
      currency: "EUR",
      chargeDay: "2026-11-03",
    });
    const gcp = parseFocusCsv(fixture("gcp.csv"), { importId: "i" });
    // A timestamp with no zone is UTC.
    expect(gcp.lines[0]).toMatchObject({
      provider: "gcp",
      chargeDay: "2026-11-04",
      tags: { env: "ci" },
    });
  });

  test("a BOM, CRLF and quoted fields import identically to the clean file (Review Focus 1)", () => {
    const clean = fixture("quoted.csv");
    const messy = `﻿${clean.replace(/\n/g, "\r\n")}`;
    const a = parseFocusCsv(clean, { importId: "i" });
    const b = parseFocusCsv(messy, { importId: "i" });
    // The embedded newline inside the quoted field is data: CRLF there becomes CRLF in the value, so
    // compare everything but the resource name, and check the name keeps its comma and line break.
    expect(b.lines.map((l) => ({ ...l, resourceName: null }))).toEqual(
      a.lines.map((l) => ({ ...l, resourceName: null })),
    );
    expect(a.lines[0]?.resourceName).toBe("notes, line one\nline two");
    expect(a.lines[0]?.tags).toEqual({ note: 'a, "b"' });
    expect(a.lines[0]?.billedCost).toBe(1.25);
  });

  test("a missing required column is a thrown error naming it", () => {
    const text = "BilledCost,BillingCurrency,ChargePeriodStart\n1,USD,2026-11-01\n";
    expect(() => parseFocusCsv(text, { importId: "i" })).toThrow(/ServiceName/);
  });

  test("a non-numeric cost skips the row with its record number and reason", () => {
    const text = [HEADER, row(BASE), row({ ...BASE, BilledCost: "n/a" })].join("\n");
    const r = parseFocusCsv(text, { importId: "i" });
    expect(r.lines).toHaveLength(1);
    expect(r.skipped).toEqual([{ row: 3, reason: "BilledCost is not a number: n/a" }]);
  });

  test("a bad date, an unknown charge category and a wrong field count are skipped", () => {
    const text = [
      HEADER,
      row({ ...BASE, ChargePeriodStart: "yesterday" }),
      row({ ...BASE, ChargeCategory: "Refund" }),
      "1,2,3",
    ].join("\n");
    const r = parseFocusCsv(text, { importId: "i" });
    expect(r.lines).toEqual([]);
    expect(r.skipped.map((s) => s.row)).toEqual([2, 3, 4]);
    expect(r.skipped[1]?.reason).toContain("Refund");
  });

  test("--provider is used when ProviderName is empty, and a conflicting ProviderName is skipped", () => {
    const text = [
      HEADER,
      row({ ...BASE, ProviderName: "" }),
      row({ ...BASE, ProviderName: "Microsoft" }),
    ].join("\n");
    const r = parseFocusCsv(text, { importId: "i", provider: "aws" });
    expect(r.lines.map((l) => l.provider)).toEqual(["aws"]);
    expect(r.skipped[0]?.reason).toContain("--provider aws");
  });

  test("no ProviderName and no --provider skips the row; an unknown provider name becomes a slug", () => {
    const text = [
      HEADER,
      row({ ...BASE, ProviderName: "" }),
      row({ ...BASE, ProviderName: "Oracle Cloud" }),
    ].join("\n");
    const r = parseFocusCsv(text, { importId: "i" });
    expect(r.lines.map((l) => l.provider)).toEqual(["oracle-cloud"]);
    expect(r.skipped[0]?.reason).toContain("--provider");
  });

  test("tags: at most 50, each key and value at most 128 chars; the excess is a warning, not silent", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 55; i++) many[`k${String(i).padStart(2, "0")}`] = "v";
    many["long"] = "x".repeat(129);
    const tags = `"${JSON.stringify(many).replace(/"/g, '""')}"`;
    const r = parseFocusCsv([HEADER, row({ ...BASE, Tags: tags })].join("\n"), { importId: "i" });
    expect(Object.keys(r.lines[0]?.tags ?? {})).toHaveLength(50);
    expect(r.lines[0]?.tags["long"]).toBeUndefined();
    expect(r.warnings.map((w) => w.reason)).toEqual([
      "tag long dropped: longer than 128 characters",
      "5 tags dropped beyond the first 50",
    ]);
  });

  test("a __proto__ tag is kept as an own tag, not dropped", () => {
    const tags = `"${'{"__proto__":"finance"}'.replace(/"/g, '""')}"`;
    const r = parseFocusCsv([HEADER, row({ ...BASE, Tags: tags })].join("\n"), { importId: "i" });
    expect(Object.getOwnPropertyDescriptor(r.lines[0]?.tags, "__proto__")?.value).toBe("finance");
  });

  test("tags that are not a JSON object are a warning and the row keeps no tags", () => {
    const r = parseFocusCsv([HEADER, row({ ...BASE, Tags: "not-json" })].join("\n"), {
      importId: "i",
    });
    expect(r.lines[0]?.tags).toEqual({});
    expect(r.warnings[0]?.reason).toContain("Tags");
  });

  test("two currencies in one billing period keep separate totals", () => {
    const text = [
      HEADER,
      row(BASE),
      row({ ...BASE, BillingCurrency: "EUR", BilledCost: "2" }),
    ].join("\n");
    const r = parseFocusCsv(text, { importId: "i" });
    const p = r.byPeriod.get("aws|111|2026-11");
    expect(Object.fromEntries(p?.totals ?? [])).toEqual({ USD: 1, EUR: 2 });
    expect(r.lines).toHaveLength(2);
  });

  test("the billing period falls back to the charge day's month", () => {
    const r = parseFocusCsv(
      [HEADER, row({ ...BASE, ChargePeriodStart: "2026-10-31T23:00:00Z" })].join("\n"),
      {
        importId: "i",
      },
    );
    expect(r.lines[0]).toMatchObject({ billingPeriod: "2026-10", chargeDay: "2026-10-31" });
  });
});

describe("parseFocusCsv: adversarial input stays linear (S8786)", () => {
  const billed = (amount: string): number | string => {
    const r = parseFocusCsv([HEADER, row({ ...BASE, BilledCost: amount })].join("\n"), {
      importId: "i",
    });
    return r.lines[0]?.billedCost ?? (r.skipped[0]?.reason ?? "").slice(0, 30);
  };
  const provider = (name: string): string | undefined =>
    parseFocusCsv([HEADER, row({ ...BASE, ProviderName: name })].join("\n"), { importId: "i" })
      .lines[0]?.provider;

  test("the amount grammar is unchanged", () => {
    for (const [text, want] of [
      ["1", 1],
      ["1.", 1],
      ["1.5", 1.5],
      [".5", 0.5],
      ["-2", -2],
      ["+2.5E-2", 0.025],
      ["3e2", 300],
      [" 4 ", 4],
    ] as const) {
      expect(billed(text)).toBe(want);
    }
    for (const bad of ["", ".", "1.2.3", "e3", "1e", "--1", "1x", "0x10", "Infinity"]) {
      expect(String(billed(bad))).toStartWith("BilledCost is not a number");
    }
  });

  test("100 000 digits followed by a non-digit (the backtracking shape) is refused quickly", () => {
    const started = performance.now();
    expect(String(billed(`${"1".repeat(100_000)}x`))).toStartWith("BilledCost is not a number");
    expect(String(billed(`${"1".repeat(50_000)}.${"1".repeat(50_000)}x`))).toStartWith(
      "BilledCost is not a number",
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("the provider slug collapses and trims separators exactly as before", () => {
    expect(provider("Oracle Cloud")).toBe("oracle-cloud");
    expect(provider("  --Oracle__Cloud!!  ")).toBe("oracle-cloud");
    expect(provider("a.b/c")).toBe("a-b-c");
    expect(provider("!!!")).toBeUndefined();
    expect(provider(`x${"y".repeat(100)}`)).toBe(`x${"y".repeat(63)}`);
  });

  test("100 000 separator characters around a name slug quickly", () => {
    const started = performance.now();
    const pad = "!".repeat(100_000);
    expect(provider(`${pad}acme${pad}`)).toBe("acme");
    expect(provider(`${pad}a`)).toBe("a");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

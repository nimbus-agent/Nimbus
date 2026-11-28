// Direct tests of the export reader's guards (listing, manifest, files, decode), over a fake CLI.
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import pino from "pino";

import { spawnCaptureInternals } from "../platform/spawn-capture.ts";

import type { SyncContext } from "../sync/types.ts";
import {
  AWS_COST_GAPS,
  AWS_EXPORT_MAX_FILES,
  type AwsBillingCli,
  awsBillingCli,
  listExport,
  readExportMonth,
} from "./aws-billing-export.ts";

const ctx = {
  logger: pino({ level: "silent" }),
  rateLimiter: { acquire: async () => {} },
  getSharedSecret: async () => null,
} as unknown as SyncContext;

const HEADER =
  "BillingAccountId,BilledCost,BillingCurrency,ChargePeriodStart,ServiceName,BillingPeriodStart";
const ROW = "111,5,USD,2026-11-02T00:00:00Z,S3,2026-11-01T00:00:00Z";
const enc = (s: string) => new TextEncoder().encode(s);
const M = (e = "daily") => `focus/${e}/metadata/BILLING_PERIOD=2026-11/${e}-Manifest.json`;

function lister(pages: unknown[]): AwsBillingCli & { calls: number } {
  const cli = {
    calls: 0,
    list: async () => {
      const p = pages[cli.calls++];
      return p === undefined ? { ok: false, text: "" } : { ok: true, text: JSON.stringify(p) };
    },
    download: async () => ({ ok: false as const }),
  };
  return cli;
}

describe("listExport", () => {
  test("pages are followed; the newest manifest wins; stray keys and junk entries are ignored", async () => {
    const cli = lister([
      {
        Contents: [
          { Key: M(), LastModified: "2026-11-01T00:00:00Z" },
          { Key: "focus/daily/data/x.csv.gz" },
          { Key: "other/prefix/metadata/BILLING_PERIOD=2026-11/a-Manifest.json" },
          { Key: 5 },
          "junk",
        ],
        NextToken: "t1",
      },
      {
        Contents: [
          {
            Key: "focus/daily/metadata/BILLING_PERIOD=2026-11/run1/daily-Manifest.json",
            LastModified: "2026-11-02T00:00:00Z",
          },
          {
            Key: "focus/daily/metadata/BILLING_PERIOD=2026-10/daily-Manifest.json",
            LastModified: "garbage",
          },
        ],
      },
    ]);
    const l = await listExport(ctx, cli, "b", "focus");
    expect(l.kind).toBe("listing");
    if (l.kind !== "listing") return;
    expect(l.periods.get("2026-11")?.key).toContain("run1/daily-Manifest.json");
    expect(l.periods.get("2026-10")?.lastModified).toBe(0);
    expect(cli.calls).toBe(2);
  });

  test("an older manifest does not replace a newer one; a tie goes to the later key", async () => {
    const l = await listExport(
      ctx,
      lister([
        {
          Contents: [
            { Key: M(), LastModified: "2026-11-05T00:00:00Z" },
            {
              Key: "focus/daily/metadata/BILLING_PERIOD=2026-11/run1/daily-Manifest.json",
              LastModified: "2026-11-01T00:00:00Z",
            },
          ],
        },
      ]),
      "b",
      "focus",
    );
    expect(l.kind === "listing" && l.periods.get("2026-11")?.key).toBe(M());
    const tie = await listExport(
      ctx,
      lister([
        {
          Contents: [
            { Key: M(), LastModified: "2026-11-05T00:00:00Z" },
            {
              Key: "focus/daily/metadata/BILLING_PERIOD=2026-11/a/daily-Manifest.json",
              LastModified: "2026-11-05T00:00:00Z",
            },
          ],
        },
      ]),
      "b",
      "focus",
    );
    expect(tie.kind === "listing" && tie.periods.get("2026-11")?.key).toBe(M());
  });

  test("an empty prefix lists from the bucket root", async () => {
    let seen = "x";
    const cli: AwsBillingCli = {
      list: async (_b, prefix) => {
        seen = prefix;
        return {
          ok: true,
          text: JSON.stringify({
            Contents: [{ Key: "metadata/BILLING_PERIOD=2026-11/e-Manifest.json" }],
          }),
        };
      },
      download: async () => ({ ok: false }),
    };
    expect((await listExport(ctx, cli, "b", "")).kind).toBe("listing");
    expect(seen).toBe("");
  });

  test("gaps: a failed page, no manifest, two exports, a stuck token, the page cap", async () => {
    const gap = async (pages: unknown[]) => {
      const l = await listExport(ctx, lister(pages), "b", "focus");
      return l.kind === "gap" ? l.reason : "listing";
    };
    expect(await gap([])).toBe(AWS_COST_GAPS.list);
    expect(await gap([{ Contents: [] }])).toBe(AWS_COST_GAPS.empty);
    expect(await gap([{ Contents: [{ Key: M("a") }, { Key: M("b") }] }])).toBe(
      AWS_COST_GAPS.severalExports,
    );
    expect(await gap([{ NextToken: "t" }, { NextToken: "t" }])).toBe(AWS_COST_GAPS.list);
    const endless = Array.from({ length: 30 }, (_, i) => ({
      Contents: [],
      NextToken: `t${String(i)}`,
    }));
    expect(await gap(endless)).toBe(AWS_COST_GAPS.listCap);
  });

  test("a CLI answer that is not JSON is a listing gap", async () => {
    const cli: AwsBillingCli = {
      list: async () => ({ ok: true, text: "not json" }),
      download: async () => ({ ok: false }),
    };
    expect(await listExport(ctx, cli, "b", "focus")).toEqual({
      kind: "gap",
      reason: AWS_COST_GAPS.list,
    });
  });
});

function files(
  manifest: unknown,
  data: Record<string, Uint8Array | undefined> = {},
): AwsBillingCli {
  return {
    list: async () => ({ ok: false, text: "" }),
    download: async (url) => {
      const key = url.replace("s3://b/", "");
      if (key === "m.json") {
        if (manifest === null) return { ok: false };
        const text = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
        return { ok: true, bytes: enc(text) };
      }
      const d = data[key];
      return d === undefined ? { ok: false } : { ok: true, bytes: d };
    },
  };
}
const REF = { key: "m.json", lastModified: 0 };
const read = (cli: AwsBillingCli, cap?: number) =>
  readExportMonth(cli, "b", "focus", REF, "2026-11", cap);
const reason = (r: unknown) => (r as { reason?: string }).reason ?? "";

describe("readExportMonth guards", () => {
  test("manifest: unreadable, not JSON, no or non-string dataFiles", async () => {
    expect(reason(await read(files(null)))).toContain("manifest could not be read");
    expect(reason(await read(files("not json")))).toContain("lists no data files");
    expect(reason(await read(files({ dataFiles: [] })))).toContain("lists no data files");
    expect(reason(await read(files({ dataFiles: [3] })))).toContain("lists no data files");
    expect(reason(await read(files([])))).toContain("lists no data files");
  });

  test("files: outside the prefix, a dot-dot segment, Parquet, too many", async () => {
    expect(reason(await read(files({ dataFiles: ["s3://b/elsewhere/x.csv"] })))).toContain(
      "outside",
    );
    expect(reason(await read(files({ dataFiles: ["s3://b/focus/../x.csv"] })))).toContain(
      "outside",
    );
    expect(reason(await read(files({ dataFiles: ["s3://b/focus/a.SNAPPY.PARQUET"] })))).toBe(
      AWS_COST_GAPS.parquet,
    );
    const many = Array.from(
      { length: AWS_EXPORT_MAX_FILES + 1 },
      (_, i) => `s3://b/focus/f${String(i)}.csv`,
    );
    expect(reason(await read(files({ dataFiles: many })))).toContain("more than");
  });

  test("a prefix-less export accepts any key in the bucket", async () => {
    const cli = files({ dataFiles: ["s3://b/x.csv"] }, { "x.csv": enc(`${HEADER}\n${ROW}\n`) });
    expect(Array.isArray(await readExportMonth(cli, "b", "", REF, "2026-11"))).toBe(true);
  });

  test("decode: a failed download, bad gzip, bad UTF-8, a differing header, a byte-order mark", async () => {
    const one = (name: string, bytes?: Uint8Array) =>
      read(files({ dataFiles: [`s3://b/focus/${name}`] }, { [`focus/${name}`]: bytes }));
    expect(reason(await one("a.csv"))).toContain("file could not be read");
    expect(reason(await one("a.csv.gz", enc("plain")))).toContain("not a valid gzip");
    expect(reason(await one("a.csv", Uint8Array.from([0xff, 0xfe, 0x41])))).toContain(
      "not valid UTF-8",
    );
    const two = files(
      { dataFiles: ["s3://b/focus/a.csv", "s3://b/focus/b.csv"] },
      { "focus/a.csv": enc(`﻿${HEADER}\n${ROW}\n`), "focus/b.csv": enc(`${HEADER}\n${ROW}`) },
    );
    expect(Array.isArray(await read(two))).toBe(true);
    const diff = files(
      { dataFiles: ["s3://b/focus/a.csv", "s3://b/focus/b.csv"] },
      { "focus/a.csv": enc(`${HEADER}\n${ROW}\n`), "focus/b.csv": enc("X,Y\n1,2\n") },
    );
    expect(reason(await read(diff))).toContain("different headers");
  });

  test("a header-only file with no newline, and an export of only blank files", async () => {
    const hdr = files({ dataFiles: ["s3://b/focus/a.csv"] }, { "focus/a.csv": enc(HEADER) });
    expect(reason(await read(hdr))).toContain("no rows");
    const blank = files({ dataFiles: ["s3://b/focus/a.csv"] }, { "focus/a.csv": enc("  \n") });
    expect(reason(await read(blank))).toContain("empty");
  });

  test("caps and parse failures: decoded text, an unterminated quote, missing columns", async () => {
    const one = files(
      { dataFiles: ["s3://b/focus/a.csv"] },
      { "focus/a.csv": enc(`${HEADER}\n${ROW}\n`) },
    );
    expect(reason(await read(one, 10))).toContain("decoded-text cap");
    const quote = files(
      { dataFiles: ["s3://b/focus/a.csv"] },
      { "focus/a.csv": enc('"unterminated\n') },
    );
    expect(reason(await read(quote))).toContain("not a FOCUS CSV");
    const cols = files({ dataFiles: ["s3://b/focus/a.csv"] }, { "focus/a.csv": enc("a,b\n1,2\n") });
    expect(reason(await read(cols))).toContain("not a FOCUS CSV");
  });

  test("rows with an empty BillingAccountId are refused", async () => {
    const cli = files(
      { dataFiles: ["s3://b/focus/a.csv"] },
      { "focus/a.csv": enc(`${HEADER}\n,5,USD,2026-11-02T00:00:00Z,S3,2026-11-01T00:00:00Z\n`) },
    );
    expect(reason(await read(cli))).toContain("BillingAccountId");
  });
});

describe("awsBillingCli", () => {
  test("list runs s3api list-objects-v2 with the prefix, page size and token; download is a no-spawn failure for a missing file", async () => {
    const argvs: string[][] = [];
    const real = spawnCaptureInternals.spawn;
    spawnCaptureInternals.spawn = ((cmd: string, args: readonly string[]) => {
      argvs.push([cmd, ...args]);
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = (): void => {};
      queueMicrotask(() => {
        proc.stdout.emit("data", Buffer.from("{}"));
        proc.emit("close", 0);
      });
      return proc;
    }) as unknown as typeof spawnCaptureInternals.spawn;
    try {
      const withCreds = {
        ...ctx,
        getSharedSecret: async (_s: string, k: string) => (k === "profile" ? "p" : null),
      } as unknown as SyncContext;
      const cli = awsBillingCli(withCreds, { AWS_PROFILE: "p" });
      expect(await cli.list("b", "focus/", "tok")).toEqual({ ok: true, text: "{}" });
      expect(argvs[0]).toContain("list-objects-v2");
      expect(argvs[0]).toContain("--starting-token");
      expect(await cli.download("s3://b/focus/missing")).toEqual({ ok: false });
    } finally {
      spawnCaptureInternals.spawn = real;
    }
  });
});

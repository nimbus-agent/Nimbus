import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { costRunner } from "./cost.ts";
import { type CostImportIpc, parseCostImportArgs, runCostImportWith } from "./cost-import-cli.ts";

function fake(r: unknown | Error): CostImportIpc & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call(method, params) {
      calls.push([method, params]);
      if (r instanceof Error) throw r;
      return r;
    },
  };
}

function sink() {
  const s = { out: "", err: "" };
  return {
    s,
    sink: {
      out: (x: string) => {
        s.out += x;
      },
      err: (x: string) => {
        s.err += x;
      },
    },
  };
}

const FILE = {
  name: "aws.csv",
  importId: "focus:0123456789abcdef",
  status: "imported",
  lines: 3,
  inserted: 3,
  replaced: 0,
  unchanged: 0,
  removed: 0,
  totals: { USD: 50 },
  skippedCount: 0,
  skipped: [],
  warningCount: 0,
  warnings: [],
};

describe("parseCostImportArgs", () => {
  const cwd = resolve("/work");
  test("a relative path is resolved against the current directory", () => {
    expect(parseCostImportArgs(["exports"], cwd)).toEqual({
      mode: "import",
      path: join(cwd, "exports"),
      dryRun: false,
      json: false,
    });
  });

  test("flags", () => {
    expect(
      parseCostImportArgs(["a.csv", "--provider", "gcp", "--dry-run", "--json"], cwd),
    ).toMatchObject({
      provider: "gcp",
      dryRun: true,
      json: true,
    });
    expect(parseCostImportArgs(["--remove", "focus:0123456789abcdef"], cwd)).toEqual({
      mode: "remove",
      importId: "focus:0123456789abcdef",
      json: false,
    });
  });

  test("usage errors", () => {
    for (const bad of [
      [],
      ["a.csv", "b.csv"],
      ["a.csv", "--provider", "oci"],
      ["a.csv", "--provider"],
      ["--remove"],
      ["--remove", "x", "a.csv"],
      ["--remove", "x", "--dry-run"],
      ["a.csv", "--bogus"],
    ]) {
      expect(parseCostImportArgs(bad, cwd)).toBeUndefined();
    }
  });
});

describe("runCostImportWith", () => {
  test("renders each file and exits 0 when all imported", async () => {
    const c = fake({ dryRun: false, files: [FILE] });
    const { s, sink: k } = sink();
    const code = await runCostImportWith(
      c,
      { mode: "import", path: "/x", dryRun: false, json: false },
      k,
    );
    expect(code).toBe(0);
    expect(c.calls).toEqual([["cost.import", { path: "/x", dryRun: false }]]);
    expect(s.out).toContain("Imported 1 of 1 file.");
    expect(s.out).toContain("3 lines (3 new, 0 restated, 0 unchanged, 0 removed)  total 50.00 USD");
  });

  test("a refused file exits 1 and names the reason on stderr; skipped rows are listed", async () => {
    const files = [
      { ...FILE, skippedCount: 2, skipped: [{ row: 3, reason: "BilledCost is not a number: x" }] },
      {
        ...FILE,
        name: "b.csv",
        status: "refused",
        error: "not a FOCUS export: missing required column ServiceName",
      },
    ];
    const { s, sink: k } = sink();
    const code = await runCostImportWith(
      fake({ dryRun: false, files }),
      { mode: "import", path: "/x", dryRun: false, json: false },
      k,
    );
    expect(code).toBe(1);
    expect(s.out).toContain("record 3: BilledCost is not a number");
    expect(s.out).toContain("... and 1 more");
    expect(s.err).toContain("b.csv: refused - not a FOCUS export");
  });

  test("an already-imported export is unchanged, names --remove, and exits 0", async () => {
    const { s, sink: k } = sink();
    const code = await runCostImportWith(
      fake({ dryRun: false, files: [{ ...FILE, status: "unchanged", lines: 0, inserted: 0 }] }),
      { mode: "import", path: "/x", dryRun: false, json: false },
      k,
    );
    expect(code).toBe(0);
    expect(s.out).toContain("Imported 0 of 1 file (1 already imported).");
    expect(s.out).toContain(
      "aws.csv  focus:0123456789abcdef  already imported, nothing written (nimbus cost import --remove focus:0123456789abcdef imports it again)",
    );
  });

  test("a dry run says nothing was written; --json prints the report", async () => {
    const { s, sink: k } = sink();
    await runCostImportWith(
      fake({ dryRun: true, files: [{ ...FILE, status: "dry_run" }] }),
      { mode: "import", path: "/x", dryRun: true, json: false },
      k,
    );
    expect(s.out).toContain("nothing was written");
    const j = sink();
    await runCostImportWith(
      fake({ dryRun: false, files: [FILE] }),
      { mode: "import", path: "/x", dryRun: false, json: true },
      j.sink,
    );
    expect(JSON.parse(j.s.out)).toMatchObject({ files: [{ name: "aws.csv" }] });
  });

  test("remove, and a gateway error exits 1 with control characters stripped", async () => {
    const { s, sink: k } = sink();
    expect(
      await runCostImportWith(
        fake({ importId: "focus:0123456789abcdef", removed: 4 }),
        { mode: "remove", importId: "focus:0123456789abcdef", json: false },
        k,
      ),
    ).toBe(0);
    expect(s.out).toBe("Removed 4 cost lines of import focus:0123456789abcdef.\n");
    const e = sink();
    expect(
      await runCostImportWith(
        fake(new Error("ERR_COST_IMPORT: bad\u001b[31m")),
        { mode: "import", path: "/x", dryRun: false, json: false },
        e.sink,
      ),
    ).toBe(1);
    expect(e.s.err).not.toContain("\u001b");
  });

  test("costRunner routes `import`", () => {
    const { sink: k } = sink();
    expect(costRunner(["import", "a.csv"], k)).toBeDefined();
    expect(costRunner(["import"], k)).toBeUndefined();
  });
});

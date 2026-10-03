import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";

import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  MAX_ACCEPTANCE_DAYS,
} from "./accepted-advisories.ts";
import { blockingAuditIgnores } from "./advisory-ignore-args.ts";
import {
  evaluateAdvisories,
  type FindingKind,
  keyOf,
  type LiveAdvisory,
  utcToday,
} from "./check-accepted-advisories.ts";
import { REPO_ROOT } from "./lib.ts";

const ROW: AcceptedAdvisory = {
  ghsa: "GHSA-aaaa-bbbb-cccc",
  package: "left-pad",
  severity: "high",
  noFixReason: "no patched release exists",
  reachability: "the vulnerable function is never called",
  unblockedBy: "upstream publishes a patched release",
  acceptedOn: "2026-01-01",
  recheckBy: "2026-01-31",
  owner: "@AsafGolombek",
};

/**
 * The only argument shape this module may ever emit: one flag per advisory, carrying a full GHSA id
 * spelled exactly as bun's advisory URLs spell it. bun 1.3.14 matches `--ignore` by substring of
 * the advisory URL, is case-sensitive, and splits neither a comma-joined value nor a CVE id.
 */
const BUN_IGNORE_ARG_RE = /^--ignore=GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

function argsOn(rows: readonly AcceptedAdvisory[], today: string): readonly string[] {
  return blockingAuditIgnores(rows, today).args;
}

function dayAfter(iso: string): string {
  return new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);
}

function asLive(row: AcceptedAdvisory): LiveAdvisory {
  return {
    package: row.package,
    ghsa: row.ghsa,
    severity: row.severity,
    title: "",
    vulnerableVersions: "",
  };
}

describe("blockingAuditIgnores: the acceptance window", () => {
  test("an open row becomes exactly one --ignore=<GHSA> argument", () => {
    expect(argsOn([ROW], "2026-01-15")).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
  });

  test("a row past its recheckBy produces NO argument, and says why", () => {
    const out = blockingAuditIgnores([ROW], "2026-02-01");
    expect(out.args).toEqual([]);
    expect(out.honoured).toEqual([]);
    expect(out.withheld).toHaveLength(1);
    expect(out.withheld[0]?.reason).toContain("recheckBy 2026-01-31 has passed");
  });

  test("recheckBy is inclusive: honoured ON the date, withheld from the day after", () => {
    expect(argsOn([ROW], "2026-01-31")).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
    expect(argsOn([ROW], "2026-02-01")).toEqual([]);
  });

  test("a malformed date withholds the row: fail closed, never open-ended", () => {
    // `2026/11/02` is the sharp one: Date.parse ACCEPTS it, so only the YYYY-MM-DD shape check
    // stands between a typo and a row whose expiry arithmetic runs on a different date format.
    const bad: Array<Partial<AcceptedAdvisory>> = [
      { recheckBy: "soon" },
      { recheckBy: "2026/11/02" },
      { recheckBy: "2026-13-01" },
      { recheckBy: "" },
      { acceptedOn: "2026-00-10" },
    ];
    for (const patch of bad) {
      const out = blockingAuditIgnores([{ ...ROW, ...patch }], "2026-01-15");
      expect(out.args).toEqual([]);
      expect(out.withheld[0]?.reason).toStartWith("malformed:");
    }
  });

  test("every other row rule audit:advisories applies also withholds the row", () => {
    const cases: Record<string, AcceptedAdvisory> = {
      "a blank justification": { ...ROW, reachability: "   " },
      [`a window longer than ${String(MAX_ACCEPTANCE_DAYS)} days`]: {
        ...ROW,
        recheckBy: "2026-12-31",
      },
      "a recheckBy at or before acceptedOn": { ...ROW, recheckBy: "2026-01-01" },
    };
    for (const [name, row] of Object.entries(cases)) {
      expect({ name, args: argsOn([row], "2026-01-01") }).toEqual({ name, args: [] });
    }
  });

  test("a row dated after today is withheld, so the window cap cannot be stretched", () => {
    // ROW is dated 2026-01-01. One day of slack covers an author already on tomorrow's date.
    expect(argsOn([ROW], "2025-12-31")).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
    const early = blockingAuditIgnores([ROW], "2025-12-30");
    expect(early.args).toEqual([]);
    expect(early.withheld[0]?.reason).toContain("acceptedOn 2026-01-01 is after today");
    // In-cap window, ten years out: without the rule this would be passed over for a decade.
    const decade = { ...ROW, acceptedOn: "2036-01-01", recheckBy: "2036-04-01" };
    expect(argsOn([decade], "2026-01-15")).toEqual([]);
  });

  test("two rows for one package+advisory withhold BOTH copies", () => {
    const out = blockingAuditIgnores([ROW, ROW], "2026-01-15");
    expect(out.args).toEqual([]);
    expect(out.withheld).toHaveLength(2);
  });

  test("a today that is not YYYY-MM-DD throws, rather than keeping every row open", () => {
    // Against a NaN date `isExpired` is false for every row, so silently accepting a bad clock
    // would make every acceptance permanent.
    for (const today of ["", "October 3rd", "2026-11-2"]) {
      expect(() => blockingAuditIgnores([ROW], today)).toThrow("today must be YYYY-MM-DD");
    }
  });

  test("an empty registry yields no arguments", () => {
    expect(argsOn([], "2026-01-15")).toEqual([]);
  });
});

describe("blockingAuditIgnores: one rule set with audit:advisories", () => {
  // The point of this module is that the blocking step cannot drift from audit:advisories about
  // what an acceptable row is. Hold the two to the same answer for every row variant and date: a
  // row is passed over by the blocking step exactly when audit:advisories, seeing its advisory
  // live, raises no malformed / duplicate / expired finding for it.
  const REJECTING: ReadonlySet<FindingKind> = new Set(["malformed", "duplicate", "expired"]);
  const registries: Record<string, AcceptedAdvisory[]> = {
    open: [ROW],
    "malformed recheckBy": [{ ...ROW, recheckBy: "2026-13-01" }],
    "window too long": [{ ...ROW, recheckBy: "2026-12-31" }],
    "blank owner": [{ ...ROW, owner: "" }],
    "dated in the future": [{ ...ROW, acceptedOn: "2026-01-30", recheckBy: "2026-03-01" }],
    duplicate: [ROW, ROW],
    "two packages": [ROW, { ...ROW, package: "right-pad", ghsa: "GHSA-dddd-eeee-ffff" }],
  };
  const days = ["2025-12-15", "2026-01-01", "2026-01-30", "2026-01-31", "2026-02-01", "2027-01-01"];

  for (const [name, rows] of Object.entries(registries)) {
    test(`agrees on: ${name}`, () => {
      for (const today of days) {
        const rejected = new Set(
          evaluateAdvisories(rows.map(asLive), rows, today)
            .filter((f) => REJECTING.has(f.kind))
            .map((f) => f.key),
        );
        const { honoured } = blockingAuditIgnores(rows, today);
        for (const row of rows) {
          const gateAccepts = !rejected.has(keyOf(row.package, row.ghsa));
          expect({ today, row: row.package, passed: honoured.includes(row) }).toEqual({
            today,
            row: row.package,
            passed: gateAccepts,
          });
        }
      }
    });
  }
});

describe("blockingAuditIgnores: only what bun matches exactly", () => {
  test("never emits anything but a full GHSA id, since bun matches --ignore by SUBSTRING", () => {
    // bun 1.3.14 drops an advisory when an --ignore value is a substring of its URL. Measured
    // against this lockfile: `--ignore=GHSA` alone and `--ignore=https://github.com/advisories/`
    // each silenced EVERY live advisory, and a URL-form value would also match any longer URL it
    // prefixes. A lower-case id or a CVE id matched nothing, so emitting one would only mislead.
    const notExact = [
      "GHSA",
      "https://github.com/advisories/",
      "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      "ghsa-aaaa-bbbb-cccc",
      "GHSA-AAAA-BBBB-CCCC",
      "GHSA-aaaa-bbbb-ccc",
      "GHSA-aaaa-bbbb-ccccc",
      " GHSA-aaaa-bbbb-cccc",
      "GHSA-aaaa-bbbb-cccc,GHSA-dddd-eeee-ffff",
      "CVE-2026-93687",
    ];
    for (const ghsa of notExact) {
      const out = blockingAuditIgnores([{ ...ROW, ghsa }], "2026-01-15");
      expect({ ghsa, args: out.args }).toEqual({ ghsa, args: [] });
      expect(out.withheld[0]?.reason).toContain("not an exact GHSA id");
    }
  });

  test("each advisory is its own argument, in registry order, never comma-joined", () => {
    const second = { ...ROW, package: "right-pad", ghsa: "GHSA-dddd-eeee-ffff" };
    const args = argsOn([ROW, second], "2026-01-15");
    expect(args).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc", "--ignore=GHSA-dddd-eeee-ffff"]);
    for (const arg of args) expect(arg).toMatch(BUN_IGNORE_ARG_RE);
  });

  test("one GHSA accepted for two packages is emitted once", () => {
    const otherPackage = { ...ROW, package: "right-pad" };
    expect(argsOn([ROW, otherPackage], "2026-01-15")).toEqual(["--ignore=GHSA-aaaa-bbbb-cccc"]);
  });

  test("a GHSA is all-or-nothing: one withheld row for it withholds the other package's open row", () => {
    // bun cannot scope --ignore to a package, so honouring left-pad's open row would also pass
    // over right-pad's EXPIRED acceptance of the same advisory.
    const expiredOther = {
      ...ROW,
      package: "right-pad",
      acceptedOn: "2025-12-01",
      recheckBy: "2026-01-10",
    };
    const out = blockingAuditIgnores([ROW, expiredOther], "2026-01-15");
    expect(out.args).toEqual([]);
    expect(out.withheld.map((w) => w.package).sort((a, b) => a.localeCompare(b))).toEqual([
      "left-pad",
      "right-pad",
    ]);
    expect(out.withheld.find((w) => w.package === "left-pad")?.reason).toContain(
      "cannot limit --ignore to one package",
    );
  });
});

describe("the committed registry, as the blocking step reads it", () => {
  test("every row is passed over from acceptedOn through recheckBy, and not the day after", () => {
    // Pinned to each row's own dates rather than the clock, so this cannot rot: it proves every
    // committed row is usable by the BLOCKING step (exact GHSA id, valid window), and that each
    // one stops being honoured the moment its window closes.
    for (const row of ACCEPTED_ADVISORIES) {
      const arg = `--ignore=${row.ghsa}`;
      expect(arg).toMatch(BUN_IGNORE_ARG_RE);
      expect(argsOn([row], row.acceptedOn)).toEqual([arg]);
      expect(argsOn([row], row.recheckBy)).toEqual([arg]);
      expect(argsOn([row], dayAfter(row.recheckBy))).toEqual([]);
    }
  });
});

describe("the CLI that security.yml runs", () => {
  test("prints exactly the computed arguments, one per line, and nothing else, then exits 0", () => {
    const before = utcToday();
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "advisory-ignore-args.ts")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const after = utcToday();

    expect(p.exitCode).toBe(0);
    const lines = p.stdout.toString().split("\n");
    expect(lines.pop()).toBe(""); // newline-terminated, or empty when nothing is open
    // Anchored, so a stray CR or a banner line on stdout would fail here.
    for (const line of lines) expect(line).toMatch(BUN_IGNORE_ARG_RE);
    // Either date, so a run that straddles UTC midnight cannot flake.
    const expected = [before, after].map((d) =>
      blockingAuditIgnores(ACCEPTED_ADVISORIES, d).args.join("\n"),
    );
    expect(expected).toContain(lines.join("\n"));
  });
});

describe("security.yml reads the registry instead of carrying a copy", () => {
  const source = readFileSync(join(REPO_ROOT, ".github", "workflows", "security.yml"), "utf8");

  /** Whole-line comments are prose, not invocations (the same rule as scripts/preflight.test.ts). */
  function dropCommentLines(text: string): string {
    return text
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
  }

  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  /** Every `run:` script of the `audit` job (`Dependency audit`) that invokes the blocking audit. */
  function blockingAuditRuns(): string[] {
    const doc: unknown = yaml.load(source);
    const jobs = isRecord(doc) ? doc["jobs"] : undefined;
    const audit = isRecord(jobs) ? jobs["audit"] : undefined;
    const steps: unknown[] = isRecord(audit) && Array.isArray(audit["steps"]) ? audit["steps"] : [];
    return steps
      .map((step) => (isRecord(step) && typeof step["run"] === "string" ? step["run"] : ""))
      .filter((run) => run.includes("bun audit --audit-level high"));
  }

  test("exactly one step runs the blocking audit, with the CLI's arguments", () => {
    const runs = blockingAuditRuns();
    expect(runs).toHaveLength(1);
    const script = dropCommentLines(runs[0] ?? "");
    expect(script).toContain('ignores="$(bun scripts/structure-audit/advisory-ignore-args.ts)"');
    // `\${` is the literal bash array expansion, not a template slot.
    expect(script).toContain(`bun audit --audit-level high "\${ignore_args[@]}"`);
  });

  test("that step types in no --ignore of its own, and no advisory id or CVE", () => {
    // Scoped to the step: the cargo-audit job's RUSTSEC ignores are a different ecosystem with
    // their own process (deny.toml), and are not what this registry governs.
    const script = dropCommentLines(blockingAuditRuns()[0] ?? "");
    expect(script).not.toContain("--ignore");
    expect(script).not.toMatch(/CVE-\d{4}-\d+/);
  });

  test("no npm advisory id appears anywhere in the workflow outside a comment", () => {
    expect(dropCommentLines(source)).not.toMatch(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i);
  });
});

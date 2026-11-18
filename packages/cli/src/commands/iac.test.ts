import { describe, expect, test } from "bun:test";
import { formatIacDrift, type IacDriftFinding, parseIacArgs, runIacWith } from "./iac.ts";

const AT = Date.UTC(2026, 10, 18, 6, 0);
const f = (o: Partial<IacDriftFinding>): IacDriftFinding => ({
  workdir: "/srv/infra",
  checkedAt: AT,
  startedBy: "owner_cli",
  status: "clean",
  driftCount: 0,
  plannedChanges: 0,
  lines: [],
  ...o,
});

describe("parseIacArgs", () => {
  test("accepts drift, --workdir, --latest and --json", () => {
    expect(parseIacArgs(["drift"])).toEqual({ latest: false, json: false });
    expect(parseIacArgs(["drift", "--workdir", "/w", "--json"])).toEqual({
      latest: false,
      json: true,
      workdir: "/w",
    });
    expect(parseIacArgs(["drift", "--latest"])).toEqual({ latest: true, json: false });
  });

  test("refuses anything else", () => {
    for (const argv of [
      [],
      ["plan"],
      ["drift", "--workdir"],
      ["drift", "--workdir", ""],
      ["drift", "--workdir", "--json"],
      ["drift", "--latest", "--workdir", "/w"],
      ["drift", "--nope"],
    ]) {
      expect(parseIacArgs(argv), argv.join(" ")).toBeUndefined();
    }
  });
});

describe("formatIacDrift", () => {
  test("empty: different text for a run and for --latest", () => {
    expect(formatIacDrift([], false)).toContain("No approved Terraform workdirs");
    expect(formatIacDrift([], true)).toContain("No drift findings stored yet");
  });

  test("one line per workdir; drift lists the renderer's lines under it; control characters stripped", () => {
    const out = formatIacDrift(
      [
        f({
          status: "drift",
          driftCount: 2,
          plannedChanges: 3,
          lines: ["Drift: 2 objects ...:", "  [changed outside Terraform] a.b\u001b[31m (t, p)"],
        }),
        f({ workdir: "/clean", plannedChanges: null }),
        f({
          workdir: "/busy",
          status: "busy",
          reason: "iac: another run is using this working directory",
        }),
        f({ workdir: "/bad", status: "failed" }),
      ],
      false,
    );
    expect(out).toContain(
      "DRIFT  /srv/infra: 2 objects changed outside Terraform (checked 2026-11-18 06:00 UTC; an apply would make 3 changes)",
    );
    expect(out).toContain("    [changed outside Terraform] a.b");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("Drift: 2 objects ...:");
    expect(out).toContain(
      "CLEAN  /clean: none reported by terraform (checked 2026-11-18 06:00 UTC)",
    );
    expect(out).toContain("BUSY  /busy: iac: another run is using this working directory");
    expect(out).toContain("FAILED /bad: unknown");
  });
});

describe("runIacWith", () => {
  function client(findings: IacDriftFinding[], fail?: Error) {
    const calls: Array<[string, unknown]> = [];
    return {
      calls,
      c: {
        call: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push([method, params]);
          if (fail !== undefined && method !== "session.declareKind") throw fail;
          return { findings } as T;
        },
      },
    };
  }
  const sink = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
  };

  test("declares the cli kind first, then runs the check; exit 0 when every finding is clean", async () => {
    const h = client([f({})]);
    const k = sink();
    expect(await runIacWith(h.c, { latest: false, json: false, workdir: "/w" }, k.s)).toBe(0);
    expect(h.calls).toEqual([
      ["session.declareKind", { kind: "cli" }],
      ["iac.driftCheck", { workdir: "/w" }],
    ]);
  });

  test("--latest reads the stored findings; drift exits 1; --json prints the findings", async () => {
    const h = client([f({ status: "drift", driftCount: 1 })]);
    const k = sink();
    expect(await runIacWith(h.c, { latest: true, json: true }, k.s)).toBe(1);
    expect(h.calls[1]).toEqual(["iac.driftLatest", {}]);
    expect(JSON.parse(k.out.join("")).findings).toHaveLength(1);
  });

  test("a gateway error is printed without control characters and exits 1", async () => {
    const h = client([], new Error("ERR_IAC_DRIFT_CLI_ONLY: x\u001b[2J"));
    const k = sink();
    expect(await runIacWith(h.c, { latest: false, json: false }, k.s)).toBe(1);
    expect(k.err.join("")).toContain("ERR_IAC_DRIFT_CLI_ONLY");
    expect(k.err.join("")).not.toContain("\u001b");
  });

  test("a non-Error rejection is printed as text", async () => {
    const c = {
      call: async <T>(method: string): Promise<T> => {
        if (method === "session.declareKind") return {} as T;
        throw "plain";
      },
    };
    const k = sink();
    expect(await runIacWith(c, { latest: true, json: false }, k.s)).toBe(1);
    expect(k.err.join("")).toContain("plain");
  });
});

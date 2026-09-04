import { describe, expect, test } from "bun:test";
import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  MAX_ACCEPTANCE_DAYS,
} from "./accepted-advisories.ts";
import {
  type AuditAttempt,
  decideExit,
  evaluateAdvisories,
  isTransportFailure,
  type LiveAdvisory,
  parseBunAudit,
  runBunAuditWithRetry,
  severityRank,
} from "./check-accepted-advisories.ts";

const ROW: AcceptedAdvisory = {
  ghsa: "GHSA-aaaa-bbbb-cccc",
  package: "left-pad",
  severity: "low",
  noFixReason: "no patched release exists",
  reachability: "the vulnerable function is never called",
  unblockedBy: "upstream publishes a patched release",
  acceptedOn: "2026-01-01",
  recheckBy: "2026-04-01",
  owner: "@AsafGolombek",
};

const LIVE: LiveAdvisory = {
  package: "left-pad",
  ghsa: "GHSA-aaaa-bbbb-cccc",
  severity: "low",
  title: "left-pad pads left",
  vulnerableVersions: "<=1.0.0",
};

function kinds(findings: ReadonlyArray<{ kind: string }>): string[] {
  return findings.map((f) => f.kind).sort((a, b) => a.localeCompare(b));
}

describe("parseBunAudit", () => {
  test("parses the package-keyed envelope bun audit emits", () => {
    const stdout = JSON.stringify({
      "@hono/node-server": [
        {
          id: 1124006,
          url: "https://github.com/advisories/GHSA-frvp-7c67-39w9",
          title: "Path traversal in serve-static",
          severity: "moderate",
          vulnerable_versions: "<2.0.5",
        },
      ],
    });
    expect(parseBunAudit(stdout)).toEqual([
      {
        package: "@hono/node-server",
        ghsa: "GHSA-frvp-7c67-39w9",
        severity: "moderate",
        title: "Path traversal in serve-static",
        vulnerableVersions: "<2.0.5",
      },
    ]);
  });

  test("a clean audit yields no advisories", () => {
    expect(parseBunAudit("{}")).toEqual([]);
  });

  test("tolerates the banner bun prints before the JSON body", () => {
    const stdout = `bun audit v1.3.14\n${JSON.stringify({})}`;
    expect(parseBunAudit(stdout)).toEqual([]);
  });

  test("falls back to the advisory URL when the id is not a GHSA", () => {
    const stdout = JSON.stringify({
      foo: [
        {
          url: "https://example.test/CVE-2026-1",
          title: "t",
          severity: "high",
          vulnerable_versions: "*",
        },
      ],
    });
    expect(parseBunAudit(stdout)[0]?.ghsa).toBe("https://example.test/CVE-2026-1");
  });

  test("an unrecognised severity is treated as critical, never silently dropped", () => {
    const stdout = JSON.stringify({
      foo: [{ url: "GHSA-1111-2222-3333", title: "t", severity: "wat", vulnerable_versions: "*" }],
    });
    expect(parseBunAudit(stdout)[0]?.severity).toBe("critical");
  });

  test("throws rather than reporting clean when the payload is not JSON", () => {
    expect(() => parseBunAudit("not json")).toThrow();
  });
});

describe("evaluateAdvisories", () => {
  test("a live advisory with a current accepted row is ok", () => {
    expect(evaluateAdvisories([LIVE], [ROW], "2026-03-31")).toEqual([]);
  });

  test("a live advisory with no accepted row is a finding", () => {
    expect(kinds(evaluateAdvisories([LIVE], [], "2026-03-31"))).toEqual(["unaccepted"]);
  });

  test("matching is package-scoped: same GHSA on a different package is unaccepted", () => {
    const other = { ...LIVE, package: "right-pad" };
    // The row does not cover right-pad (unaccepted) AND left-pad is no longer
    // live (stale) — an advisory id alone must never satisfy a row.
    expect(kinds(evaluateAdvisories([other], [ROW], "2026-03-31"))).toEqual([
      "stale",
      "unaccepted",
    ]);
  });

  test("an accepted row past its recheckBy date is a finding", () => {
    expect(kinds(evaluateAdvisories([LIVE], [ROW], "2026-04-02"))).toEqual(["expired"]);
  });

  test("recheckBy is inclusive — the gate is still green on the date itself", () => {
    expect(evaluateAdvisories([LIVE], [ROW], "2026-04-01")).toEqual([]);
  });

  test("an accepted row whose advisory is no longer live is stale drift", () => {
    expect(kinds(evaluateAdvisories([], [ROW], "2026-03-31"))).toEqual(["stale"]);
  });

  test("a severity escalation above the accepted level re-opens the decision", () => {
    const escalated = { ...LIVE, severity: "high" as const };
    expect(kinds(evaluateAdvisories([escalated], [ROW], "2026-03-31"))).toEqual([
      "severity-escalated",
    ]);
  });

  test("a severity de-escalation is not a finding", () => {
    const row = { ...ROW, severity: "high" as const };
    expect(evaluateAdvisories([LIVE], [row], "2026-03-31")).toEqual([]);
  });

  test("a non-ISO date in the registry is a finding, not a silent pass", () => {
    const row = { ...ROW, recheckBy: "soon" };
    expect(kinds(evaluateAdvisories([LIVE], [row], "2026-03-31"))).toContain("malformed");
  });

  test("a recheckBy at or before acceptedOn is a finding", () => {
    const row = { ...ROW, recheckBy: "2026-01-01" };
    expect(kinds(evaluateAdvisories([LIVE], [row], "2026-03-31"))).toContain("malformed");
  });

  test(`an acceptance window longer than ${MAX_ACCEPTANCE_DAYS} days is a finding`, () => {
    const row = { ...ROW, recheckBy: "2099-01-01" };
    expect(kinds(evaluateAdvisories([LIVE], [row], "2026-03-31"))).toContain("malformed");
  });

  test("an empty justification field is a finding", () => {
    const row = { ...ROW, reachability: "   " };
    expect(kinds(evaluateAdvisories([LIVE], [row], "2026-03-31"))).toContain("malformed");
  });

  test("duplicate rows for the same advisory are a finding", () => {
    expect(kinds(evaluateAdvisories([LIVE], [ROW, ROW], "2026-03-31"))).toContain("duplicate");
  });

  test("clean audit with an empty registry is clean", () => {
    expect(evaluateAdvisories([], [], "2026-03-31")).toEqual([]);
  });
});

describe("decideExit", () => {
  test("no findings exits 0", () => {
    expect(decideExit([]).code).toBe(0);
  });

  test("any finding exits 1 and is annotated for CI", () => {
    const out = decideExit(evaluateAdvisories([LIVE], [], "2026-03-31"));
    expect(out.code).toBe(1);
    expect(out.messages.some((m) => m.startsWith("::error::"))).toBe(true);
  });

  test("every finding is reported, not just the first", () => {
    const findings = evaluateAdvisories(
      [LIVE, { ...LIVE, package: "right-pad" }],
      [],
      "2026-03-31",
    );
    expect(decideExit(findings).messages.filter((m) => m.startsWith("::error::"))).toHaveLength(2);
  });
});

describe("severityRank", () => {
  test("orders low < moderate < high < critical", () => {
    expect(severityRank("low")).toBeLessThan(severityRank("moderate"));
    expect(severityRank("moderate")).toBeLessThan(severityRank("high"));
    expect(severityRank("high")).toBeLessThan(severityRank("critical"));
  });
});

/** Today, so the registry self-check does not fail purely on date arithmetic. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

describe("ACCEPTED_ADVISORIES (the committed registry)", () => {
  test("every row is well-formed against its own rules", () => {
    // Feed the registry to the evaluator as if every row were live, so the
    // committed rows are held to the same shape/date rules as any future row.
    const asLive: LiveAdvisory[] = ACCEPTED_ADVISORIES.map((a) => ({
      package: a.package,
      ghsa: a.ghsa,
      severity: a.severity,
      title: "",
      vulnerableVersions: "",
    }));
    const findings = evaluateAdvisories(asLive, ACCEPTED_ADVISORIES, todayISO());
    expect(findings.filter((f) => f.kind === "malformed" || f.kind === "duplicate")).toEqual([]);
  });

  test("no row is accepted forever — each carries a future re-check date", () => {
    for (const a of ACCEPTED_ADVISORIES) {
      expect(Date.parse(a.recheckBy)).toBeGreaterThan(Date.parse(a.acceptedOn));
    }
  });

  test("each row names what would unblock it", () => {
    for (const a of ACCEPTED_ADVISORIES) {
      expect(a.unblockedBy.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("transport-failure retry", () => {
  test("both shapes of an unreachable endpoint are recognised as transport failures", () => {
    expect(isTransportFailure("error: audit request failed (status 503)")).toBe(true);
    // The shape that took `main` red on 2026-09-04: the socket died, so there is no status code
    // and the sibling shell step's `(status NNN)` pattern missed it entirely.
    expect(isTransportFailure("ConnectionClosed: audit request failed")).toBe(true);
  });

  test("an ordinary non-zero exit is NOT a transport failure", () => {
    // `bun audit` exits non-zero when it finds advisories. That must never be retried away, and
    // must never be mistaken for the registry being down.
    expect(isTransportFailure("")).toBe(false);
    expect(isTransportFailure("1 vulnerability (1 high)")).toBe(false);
  });

  test("a transport failure is retried, and a later success is returned", () => {
    const outcomes: AuditAttempt[] = [
      { stdout: "", stderr: "ConnectionClosed: audit request failed" },
      { stdout: "", stderr: "error: audit request failed (status 503)" },
      { stdout: '{"advisories":{}}', stderr: "" },
    ];
    let i = 0;
    const slept: number[] = [];
    const got = runBunAuditWithRetry(() => outcomes[i++] as AuditAttempt, {
      sleep: (ms) => slept.push(ms),
    });
    expect(got.attempt.stdout).toBe('{"advisories":{}}');
    expect(i).toBe(3);
    expect(slept).toEqual([10_000, 20_000]); // linear backoff, matching security.yml's shell step
  });

  test("a REAL finding is returned on the first attempt, never retried", () => {
    // The property that makes widening the match safe: output present means the audit ran, so
    // there is nothing to retry regardless of exit code.
    let calls = 0;
    const got = runBunAuditWithRetry(() => {
      calls += 1;
      return { stdout: '{"advisories":{"GHSA-x":{}}}', stderr: "" };
    });
    expect(calls).toBe(1);
    expect(got.tries).toBe(1);
  });

  test("a NON-transport failure is not retried either — it fails closed immediately", () => {
    let calls = 0;
    const got = runBunAuditWithRetry(() => {
      calls += 1;
      return { stdout: "", stderr: "bun: command not found" };
    });
    expect(calls).toBe(1);
    expect(got.attempt.stdout).toBe("");
  });

  test("exhausting every attempt still returns empty output, so the caller fails closed", () => {
    const slept: number[] = [];
    let calls = 0;
    const got = runBunAuditWithRetry(
      () => {
        calls += 1;
        return { stdout: "", stderr: "ConnectionClosed: audit request failed" };
      },
      { sleep: (ms) => slept.push(ms) },
    );
    expect(calls).toBe(3);
    expect(got.attempt.stdout).toBe("");
    expect(slept).toEqual([10_000, 20_000]);
  });
});

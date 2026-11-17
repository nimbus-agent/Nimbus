import { describe, expect, test } from "bun:test";

import { runIncidentWith } from "./incident.ts";
import {
  type FindingLike,
  type FindingsReplyLike,
  formatFindings,
  parseFindingsArgs,
} from "./incident-findings-format.ts";
import { INCIDENT_USAGE, parseIncidentArgs } from "./incident-format.ts";

const T = Date.UTC(2026, 10, 17, 12, 0, 0);

function f(over: Partial<FindingLike> = {}): FindingLike {
  return {
    kind: "radar",
    key: "deploy:checkout",
    service: "checkout",
    detail: { kind: "deploy", maxGapMs: 2 * 86_400_000, lastAtMs: T - 3 * 86_400_000 },
    openedAtMs: T,
    lastSeenAtMs: T,
    clearedAtMs: null,
    ...over,
  };
}

describe("parseFindingsArgs", () => {
  test("flags", () => {
    expect(parseFindingsArgs([])).toEqual({ verb: "findings", json: false, all: false });
    expect(parseFindingsArgs(["--all", "--limit", "20", "--json"])).toEqual({
      verb: "findings",
      json: true,
      all: true,
      limit: 20,
    });
    for (const bad of [
      ["--all", "--all"],
      ["--limit"],
      ["--limit", "0"],
      ["--limit", "501"],
      ["x"],
    ]) {
      expect(parseFindingsArgs(bad)).toBeUndefined();
    }
    expect(parseIncidentArgs(["findings"])).toMatchObject({ verb: "findings" });
    expect(INCIDENT_USAGE).toContain("nimbus incident findings [--all]");
  });
});

describe("formatFindings", () => {
  test("empty states differ for open and all", () => {
    expect(formatFindings({ findings: [] }, false)).toBe("No open findings.");
    expect(formatFindings({ findings: [] }, true)).toBe("No findings recorded.");
  });

  test("radar, anomaly and cleared lines; control characters stripped; never says it acted", () => {
    const out = formatFindings(
      {
        findings: [
          f(),
          f({ detail: { maxGapMs: 90 * 60_000, lastAtMs: null } }),
          f({ detail: { maxGapMs: 7_200_000 } }),
          f({
            kind: "anomaly",
            key: "index:errors:check\u001b[31mout",
            detail: { metric: "errors", value: 5, mean: 0.2, z: 4.8 },
            clearedAtMs: T + 1000,
          }),
          f({ kind: "anomaly", detail: null }),
        ],
      },
      true,
    );
    expect(out).toContain(
      "deploy:checkout  open since 2026-11-17T12:00:00Z; no matching event since 2026-11-14T12:00:00Z (expected within 2d)",
    );
    expect(out).toContain("no matching event ever seen (expected within 90m)");
    expect(out).toContain("(expected within 2h)");
    expect(out).toContain("cleared 2026-11-17T12:00:01Z; value 5, usual 0.2, z 4.8");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("A finding is a record only: nothing was run.");
  });
});

describe("runIncidentWith findings", () => {
  async function run(r: FindingsReplyLike, args: string[]) {
    const out: string[] = [];
    const calls: { method: string; params: unknown }[] = [];
    const ipc = {
      call: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return method === "session.declareKind" ? {} : r;
      },
    };
    const a = parseIncidentArgs(["findings", ...args]);
    if (a === undefined) throw new Error("bad args");
    const code = await runIncidentWith(ipc as never, a, { out: (s) => out.push(s), err: () => {} });
    return { code, out: out.join(""), calls };
  }

  test("declares cli, sends only the given params, prints text or JSON", async () => {
    const r = await run({ findings: [f()] }, ["--all", "--limit", "5"]);
    expect(r.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.findings"]);
    expect(r.calls[1]?.params).toEqual({ all: true, limit: 5 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy:checkout");
    const j = await run({ findings: [] }, ["--json"]);
    expect(j.calls[1]?.params).toEqual({});
    expect(JSON.parse(j.out)).toEqual({ findings: [] });
  });
});

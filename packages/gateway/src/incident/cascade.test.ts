import { describe, expect, test } from "bun:test";

import {
  CASCADE_CLUSTER_CAP,
  CASCADE_WINDOW_MS,
  type CascadeGroup,
  type CascadeReason,
  type CascadeRecord,
  clusterRecords,
  type DependsOn,
  groupOf,
  REACH_VISIT_CAP,
  rankCascades,
} from "./cascade.ts";

const T = Date.parse("2026-11-10T10:00:00.000Z");
const MIN = 60_000;

const rec = (
  id: string,
  service: string | null,
  atMs: number,
  deploymentId: string | null = null,
): CascadeRecord => ({
  id,
  service,
  source: "pagerduty",
  openedAtMs: atMs,
  deploymentId,
});

/** Services as configured: every key is configured, its value is what it depends on. */
const deps = (spec: Record<string, readonly string[]>): DependsOn => new Map(Object.entries(spec));

const CHAIN = deps({ web: ["api"], api: ["db"], db: [] });

const pathOf = (r: CascadeReason): readonly string[] =>
  r.kind === "declared_dependency" && r.path !== undefined ? r.path : [];

function only(groups: readonly CascadeGroup[]): CascadeGroup {
  expect(groups).toHaveLength(1);
  return groups[0] as CascadeGroup;
}

function perms<X>(a: readonly X[]): X[][] {
  if (a.length <= 1) return [[...a]];
  return a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("7.1 the round-1 scenario: web -> api -> db, api alerted first", () => {
  const records = [
    rec("r-api", "api", T),
    rec("r-db", "db", T + 5000),
    rec("r-web", "web", T + 10_000),
  ];

  for (const order of perms(records)) {
    test(`db is the root whatever the input order (${order.map((r) => r.id).join(",")})`, () => {
      const g = only(rankCascades(order, CHAIN));
      expect(g.root).toBe("r-db");
      expect(g.relation).toBe("declared");
      const byId = new Map(g.members.map((m) => [m.recordId, m]));
      expect(byId.get("r-db")).toMatchObject({
        role: "root",
        reason: { kind: "declared_dependency", dependents: 2 },
      });
      expect(byId.get("r-api")).toMatchObject({
        role: "downstream",
        reason: { kind: "declared_dependency", path: ["api", "db"] },
      });
      expect(byId.get("r-web")).toMatchObject({
        role: "downstream",
        reason: { kind: "declared_dependency", path: ["web", "api", "db"] },
      });
    });
  }
});

describe("7.2 root by declared dependency", () => {
  test("two services: the dependency is the root even when it opened second", () => {
    const g = only(rankCascades([rec("a", "api", T), rec("d", "db", T + MIN)], CHAIN));
    expect(g.root).toBe("d");
  });

  test("transitive with a missing middle record: db is root and the printed path runs through api", () => {
    const g = only(rankCascades([rec("w", "web", T), rec("d", "db", T + MIN)], CHAIN));
    expect(g.root).toBe("d");
    expect(g.members.find((m) => m.recordId === "w")?.reason).toEqual({
      kind: "declared_dependency",
      path: ["web", "api", "db"],
    });
  });

  test("a diamond: web depends on api and cache, both on db; db is root", () => {
    const diamond = deps({ web: ["api", "cache"], api: ["db"], cache: ["db"], db: [] });
    const g = only(
      rankCascades(
        [
          rec("w", "web", T),
          rec("a", "api", T + 1),
          rec("c", "cache", T + 2),
          rec("d", "db", T + 3),
        ],
        diamond,
      ),
    );
    expect(g.root).toBe("d");
    for (const m of g.members.filter((x) => x.role === "downstream")) {
      expect(m.reason.kind).toBe("declared_dependency");
      expect(pathOf(m.reason).length).toBeGreaterThanOrEqual(2);
    }
  });

  test("a cycle yields no relation either way: time_only for its members", () => {
    const cyc = deps({ a: ["b"], b: ["a"] });
    const g = only(rankCascades([rec("ra", "a", T), rec("rb", "b", T + MIN)], cyc));
    expect(g.relation).toBe("none");
    expect(g.root).toBe("ra");
    expect(g.members.find((m) => m.recordId === "rb")?.reason).toEqual({
      kind: "time_only",
      minutesAfterRoot: 1,
    });
  });

  test("the fallback label says shared deployment comes before open time", () => {
    const g = only(
      rankCascades(
        [rec("x", "a", T), rec("y", "b", T + MIN, "deployment:d")],
        deps({ a: [], b: [] }),
      ),
    );
    expect(g.relationLabel).toBe(
      "no depends_on is declared among these services; ranked by shared deployment, then open time",
    );
  });

  test("a member that opened BEFORE the root keeps a negative offset (never clamped to 0)", () => {
    // A opens first with no deployment; B and C share one, so B is the root although A is earlier
    const g = only(
      rankCascades(
        [
          rec("a", "sa", T),
          rec("b", "sb", T + 5 * MIN, "deployment:d"),
          rec("c", "sc", T + 6 * MIN, "deployment:d"),
        ],
        deps({ sa: [], sb: [], sc: [] }),
      ),
    );
    expect(g.root).toBe("b");
    expect(g.members.find((m) => m.recordId === "a")?.reason).toEqual({
      kind: "time_only",
      minutesAfterRoot: -5,
    });
  });

  test("a depends_on target that is not configured is ignored", () => {
    const dangling = deps({ web: ["ghost"], api: [] });
    const g = only(rankCascades([rec("w", "web", T), rec("a", "api", T + MIN)], dangling));
    expect(g.relation).toBe("none");
    expect(g.root).toBe("w");
  });

  test("no depends_on anywhere: ranked by time and labelled so", () => {
    const g = only(
      rankCascades([rec("x", "a", T + MIN), rec("y", "b", T)], deps({ a: [], b: [] })),
    );
    expect(g.root).toBe("y");
    expect(g.relation).toBe("none");
    expect(g.relationLabel).toContain("no depends_on is declared");
    expect(g.members.every((m) => m.reason.kind === "time_only")).toBe(true);
  });
});

describe("7.3 candidates, deployments and unbound records", () => {
  test("two independent top candidates are ordered by shared deployment, then open time, then id", () => {
    const two = deps({ api: ["db1"], svc: ["db2"], db1: [], db2: [] });
    const base = [
      rec("a", "api", T),
      rec("d1", "db1", T + 10 * MIN),
      rec("s", "svc", T + 2 * MIN),
      rec("d2", "db2", T + 11 * MIN),
    ];
    // by open time: db1 (T+10) before db2 (T+11)
    expect(only(rankCascades(base, two)).root).toBe("d1");
    // a deployment cited by db2 and one other record raises db2
    const shared = [
      rec("a", "api", T, "deployment:x"),
      rec("d1", "db1", T + 10 * MIN),
      rec("s", "svc", T + 2 * MIN),
      rec("d2", "db2", T + 11 * MIN, "deployment:x"),
    ];
    const g = only(rankCascades(shared, two));
    // d2 and a share a deployment but a is not top; among tops only d2 cites a shared one
    expect(g.root).toBe("d2");
    // ties fall to the id by code unit
    const tie = [
      rec("b", "api", T),
      rec("db1", "db1", T),
      rec("c", "svc", T),
      rec("db2", "db2", T),
    ];
    expect(only(rankCascades(tie, two)).root).toBe("db1");
  });

  test("an unbound record is never a candidate and is root only by time; an unrelated record is time_only", () => {
    const g = only(
      rankCascades(
        [
          rec("u", null, T),
          rec("a", "api", T + MIN),
          rec("d", "db", T + 2 * MIN),
          rec("z", "zzz", T + 3 * MIN),
        ],
        deps({ ...Object.fromEntries(CHAIN), zzz: [] }),
      ),
    );
    expect(g.root).toBe("d");
    expect(g.members.find((m) => m.recordId === "u")?.reason.kind).toBe("time_only");
    expect(g.members.find((m) => m.recordId === "z")?.reason.kind).toBe("time_only");
    const alone = only(rankCascades([rec("u", null, T), rec("v", null, T + MIN)], CHAIN));
    expect(alone.root).toBe("u");
  });

  test("a downstream member that cites the root's deployment, with no declared path, says shared_deployment", () => {
    const g = only(
      rankCascades(
        [rec("r", "api", T, "deployment:x"), rec("m", "other", T + MIN, "deployment:x")],
        deps({ api: [], other: [] }),
      ),
    );
    expect(g.root).toBe("r");
    expect(g.members.find((m) => m.recordId === "m")?.reason).toEqual({
      kind: "shared_deployment",
      deploymentId: "deployment:x",
    });
    expect(g.members.find((m) => m.recordId === "r")?.reason).toEqual({
      kind: "shared_deployment",
      deploymentId: "deployment:x",
    });
  });
});

describe("7.4 the reachability cap", () => {
  test("a chain longer than the cap sets reachCapped, treats the relation as absent and says so", () => {
    const n = REACH_VISIT_CAP + 6;
    const chain: Record<string, string[]> = {};
    for (let i = 0; i < n; i += 1) chain[`s${String(i)}`] = i + 1 < n ? [`s${String(i + 1)}`] : [];
    const g = only(
      rankCascades([rec("a", "s0", T), rec("b", `s${String(n - 1)}`, T + MIN)], deps(chain)),
    );
    expect(g.reachCapped).toBe(true);
    expect(g.relation).toBe("none");
    expect(g.members.every((m) => m.reason.kind === "time_only")).toBe(true);
    // a graph that fits the cap is exact: a 60-service chain is searched to the end in both directions
    const fit: Record<string, string[]> = {};
    for (let i = 0; i < 60; i += 1) fit[`s${String(i)}`] = i + 1 < 60 ? [`s${String(i + 1)}`] : [];
    const near = only(rankCascades([rec("a", "s0", T), rec("b", "s59", T + MIN)], deps(fit)));
    expect(near.reachCapped).toBe(false);
    expect(near.root).toBe("b");
    expect(near.relation).toBe("declared");
  });
});

describe("7.5 anchor-window clustering, not chaining", () => {
  test("records at 0, 20 and 40 minutes: the first two cluster, the third starts its own", () => {
    const clusters = clusterRecords([
      rec("a", "x", T),
      rec("b", "y", T + 20 * MIN),
      rec("c", "z", T + 40 * MIN),
    ]);
    expect(clusters.map((c) => c.map((r) => r.id))).toEqual([["a", "b"], ["c"]]);
  });

  test("a record exactly 30 minutes after the anchor is inside; one millisecond later is outside", () => {
    const edge = clusterRecords([
      rec("a", "x", T),
      rec("b", "y", T + CASCADE_WINDOW_MS),
      rec("c", "z", T + CASCADE_WINDOW_MS + 1),
    ]);
    expect(edge.map((c) => c.map((r) => r.id))).toEqual([["a", "b"], ["c"]]);
  });

  test("a cluster of one is not reported; the cap per cluster starts the next cluster", () => {
    expect(rankCascades([rec("a", "x", T)], CHAIN)).toEqual([]);
    const many = Array.from({ length: CASCADE_CLUSTER_CAP + 3 }, (_, i) =>
      rec(`r${String(i).padStart(3, "0")}`, `s${String(i)}`, T + i),
    );
    const clusters = clusterRecords(many);
    expect(clusters[0]).toHaveLength(CASCADE_CLUSTER_CAP);
    expect(clusters[1]).toHaveLength(3);
  });

  test("groupOf finds the group of a member and null for a record in none", () => {
    const groups = rankCascades(
      [rec("a", "api", T), rec("d", "db", T + MIN), rec("lone", "web", T + 5 * 60 * MIN)],
      CHAIN,
    );
    expect(groupOf(groups, "a")?.root).toBe("d");
    expect(groupOf(groups, "lone")).toBeNull();
    expect(groupOf(groups, "nope")).toBeNull();
  });
});

describe("7.6 / 7.7 properties over random DAGs and open orders", () => {
  let seed = 20_261_116;
  const rnd = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return seed / 4_294_967_296;
  };
  const pick = (n: number): number => Math.floor(rnd() * n);

  function randomCase(): { records: CascadeRecord[]; dep: DependsOn } {
    const n = 2 + pick(7);
    const names = Array.from({ length: n }, (_, i) => `s${String(i)}`);
    const spec: Record<string, string[]> = {};
    names.forEach((name, i) => {
      // edges only to a later-indexed service: a DAG; some records have no edges at all
      spec[name] = names.slice(i + 1).filter(() => rnd() < 0.35);
    });
    const count = 2 + pick(8);
    const records = Array.from({ length: count }, (_, i) =>
      rec(
        `r${String(i)}`,
        rnd() < 0.1 ? null : (names[pick(n)] as string),
        T + pick(25) * MIN,
        rnd() < 0.3 ? `deployment:${String(pick(2))}` : null,
      ),
    );
    return { records, dep: new Map(Object.entries(spec)) };
  }

  const shuffled = <X>(a: readonly X[]): X[] => {
    const out = [...a];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = pick(i + 1);
      [out[i], out[j]] = [out[j] as X, out[i] as X];
    }
    return out;
  };

  test("200 random cases: the root is never downstream of a member, every declared reason has a path, order does not matter", () => {
    for (let i = 0; i < 200; i += 1) {
      const { records, dep } = randomCase();
      const groups = rankCascades(records, dep);
      for (const g of groups) {
        const byId = new Map(records.map((r) => [r.id, r]));
        const root = byId.get(g.root) as CascadeRecord;
        if (g.relation === "declared") {
          // no member's service is upstream of the root's: the root is a top candidate
          for (const m of g.members) {
            const other = byId.get(m.recordId) as CascadeRecord;
            if (other.id === root.id || root.service === null || other.service === null) continue;
            expect(isUp(dep, other.service, root.service)).toBe(false);
          }
        }
        for (const m of g.members) {
          if (m.role === "downstream" && m.reason.kind === "declared_dependency") {
            const path = pathOf(m.reason);
            expect(path.length).toBeGreaterThanOrEqual(2);
            expect(path.at(-1) ?? null).toBe(root.service);
            expect(path[0] ?? null).toBe((byId.get(m.recordId) as CascadeRecord).service);
          }
        }
      }
      expect(rankCascades(shuffled(records), dep)).toEqual(groups);
    }
  });
});

/** Independent reference: X is upstream of Y when Y reaches X and X does not reach Y (DAG: depth-first). */
function isUp(dep: DependsOn, x: string, y: string): boolean {
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (dep.get(from) ?? []).some((n) => dep.has(n) && reaches(n, to, seen));
  };
  return x !== y && reaches(y, x) && !reaches(x, y);
}

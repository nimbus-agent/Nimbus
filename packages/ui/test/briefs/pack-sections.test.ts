import { describe, expect, it } from "vitest";
import { DESKTOP_EXCLUDED_AGENTS, packSections } from "../../src/briefs/pack-sections";
import type { CatalogAgent, CatalogListResult, PackListResult } from "../../src/ipc/types";

function agent(name: string, visible = true): CatalogAgent {
  return {
    name,
    method: `agents.${name}`,
    displayName: name.toUpperCase(),
    description: "",
    category: "knowledge",
    roles: [],
    params: [],
    surfaces: { external: true, fleet: true },
    visible,
  };
}

function catalog(...agents: CatalogAgent[]): CatalogListResult {
  return { agents, connectors: [], visibility: { basis: "packs", packs: [], notes: [] } };
}

function pack(id: string, visibleAgents?: readonly string[]): PackListResult["installed"][number] {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    source: "bundled",
    updateAvailable: false,
    ...(visibleAgents === undefined ? {} : { visibleAgents }),
  };
}

function packs(
  installed: PackListResult["installed"],
  extra: Partial<PackListResult> = {},
): PackListResult {
  return { profile: "default", installed, available: [], skipped: [], ...extra };
}

describe("packSections", () => {
  it("excludes preflight and premortem on the desktop", () => {
    expect([...DESKTOP_EXCLUDED_AGENTS].sort()).toEqual(["preflight", "premortem"]);
  });

  it("returns [] for null inputs", () => {
    expect(packSections(null, null)).toEqual([]);
    expect(packSections(packs([pack("a", ["x"])]), null)).toEqual([]);
    expect(packSections(null, catalog(agent("x")))).toEqual([]);
  });

  it("returns [] when listError is set", () => {
    const p = packs([pack("a", ["x"])], { listError: "boom" });
    expect(packSections(p, catalog(agent("x")))).toEqual([]);
  });

  it("gives a skipped pack no section", () => {
    const p = packs([pack("a", ["x"])], { skipped: [{ packId: "a", reason: "bad" }] });
    expect(packSections(p, catalog(agent("x")))).toEqual([]);
  });

  it("follows visibleAgents order and installed order", () => {
    const c = catalog(agent("a"), agent("b"), agent("c"));
    const s = packSections(packs([pack("p2", ["c", "a"]), pack("p1", ["b"])]), c);
    expect(s.map((x) => x.id)).toEqual(["p2", "p1"]);
    expect(s[0]?.name).toBe("Pack p2");
    expect(s[0]?.agents.map((a) => a.name)).toEqual(["c", "a"]);
  });

  it("drops invisible, excluded and uncatalogued agents", () => {
    const c = catalog(agent("a"), agent("hidden", false), agent("preflight"), agent("premortem"));
    const s = packSections(
      packs([pack("p", ["a", "hidden", "preflight", "premortem", "ghost"])]),
      c,
    );
    expect(s[0]?.agents.map((a) => a.name)).toEqual(["a"]);
  });

  it("omits a section left with no agents", () => {
    const c = catalog(agent("preflight"));
    expect(packSections(packs([pack("p", ["preflight"])]), c)).toEqual([]);
  });

  it("lists an agent in both packs that name it", () => {
    const c = catalog(agent("a"));
    const s = packSections(packs([pack("p1", ["a"]), pack("p2", ["a"])]), c);
    expect(s.map((x) => x.id)).toEqual(["p1", "p2"]);
  });

  it("treats a missing visibleAgents as empty", () => {
    expect(packSections(packs([pack("p")]), catalog(agent("a")))).toEqual([]);
  });
});

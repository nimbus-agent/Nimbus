import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { checkPackFragment } from "../config/pack-settable.ts";
import { resolveSourceMapping } from "../sources/source-mapping.ts";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";
import { createPackLayerStore } from "./pack-layer-store.ts";
import { validatePackContent } from "./pack-validate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BUNDLED_PACKS", () => {
  test("holds pm, devops and developer", () => {
    expect([...BUNDLED_PACKS.keys()].sort()).toEqual(["developer", "devops", "pm"]);
    expect(BUNDLED_PACKS.get("pm")?.members).toEqual([]);
  });

  test("devops is 1.1.0 and turns the on-call pushed brief on", () => {
    const devops = BUNDLED_PACKS.get("devops");
    expect(devops?.version).toBe("1.1.0");
    const r = checkPackFragment(devops?.defaults ?? "", checkPackFleetJobs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.scalars.get("oncall.push.enabled")).toBe(true);
    expect(r.scalars.get("fleet.enabled")).toBe(true);
  });

  test("pm is 1.1.0 and maps Google Docs as a doc source", () => {
    const pm = BUNDLED_PACKS.get("pm");
    expect(pm?.version).toBe("1.1.0");
    const r = checkPackFragment(pm?.defaults ?? "", checkPackFleetJobs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lists.get("sources.map")).toEqual(["google_drive:doc=doc"]);
    const mapping = resolveSourceMapping({
      doc: mergeLayerDocs([
        parseLayerDoc({ kind: "pack", id: "pm", path: "/virtual/pm.toml" }, pm?.defaults ?? ""),
      ]),
    });
    expect(mapping.notes).toEqual([]);
    expect(mapping.kindOf("google_drive:doc")).toBe("doc");
    expect(mapping.typesFor("decisions")).toContain("google_drive:doc");
    expect(mapping.typesFor("glossary")).toContain("google_drive:doc");
  });

  test("developer is 1.0.0, sets only [agents] visible, and every name is a catalog agent", () => {
    const dev = BUNDLED_PACKS.get("developer");
    expect(dev?.version).toBe("1.0.0");
    expect(dev?.members).toEqual([]);
    const r = checkPackFragment(dev?.defaults ?? "", checkPackFleetJobs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.scalars.keys()]).toEqual([]);
    expect([...r.lists.keys()]).toEqual(["agents.visible"]);
    const visible = r.lists.get("agents.visible") ?? [];
    // The coding agent's MCP read tools reach these (packages/cli/src/mcp/agent-tools.ts pins the
    // same set from its side). premortem and preflight are deliberately NOT reachable there.
    expect([...visible].sort()).toEqual([
      "catchup",
      "conflicts",
      "decisions",
      "expert",
      "glossary",
      "impact",
      "ownership",
      "why",
    ]);
    for (const name of visible) expect(CATALOG_AGENT_NAMES).toContain(name);
  });

  test("every bundled pack passes checkPackFragment with checkPackFleetJobs", () => {
    for (const m of BUNDLED_PACKS.values()) {
      const r = checkPackFragment(m.defaults, checkPackFleetJobs);
      expect(r.ok).toBe(true);
    }
  });

  test("every bundled pack passes validatePackContent against the live catalog", () => {
    const deps = {
      connectorIds: new Set(builtinCatalogConnectorIds()),
      agentNames: new Set(CATALOG_AGENT_NAMES),
    };
    for (const m of BUNDLED_PACKS.values()) {
      expect(validatePackContent(m, deps)).toEqual([]);
    }
  });

  test("pm and devops install into one temp profile without conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-bundled-packs-"));
    dirs.push(dir);
    const store = createPackLayerStore({ configDir: dir });
    for (const m of BUNDLED_PACKS.values()) {
      store.setPackLayer("default", m.id, m.defaults);
    }
    expect(store.readPackLayerText("default", "pm")).toContain("pm-decisions-nightly");
    expect(store.readPackLayerText("default", "devops")).toContain("devops-changelog-nightly");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import { checkPackFragment } from "../config/pack-settable.ts";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import { checkPackFleetJobs } from "./pack-job-check.ts";
import { createPackLayerStore } from "./pack-layer-store.ts";
import { validatePackContent } from "./pack-validate.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("BUNDLED_PACKS", () => {
  test("holds pm and devops", () => {
    expect([...BUNDLED_PACKS.keys()].sort()).toEqual(["devops", "pm"]);
    expect(BUNDLED_PACKS.get("pm")?.members).toEqual([]);
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

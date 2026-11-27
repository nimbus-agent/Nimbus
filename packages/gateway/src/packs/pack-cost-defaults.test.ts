// Phase 7 slice 7: the finops pack's cost defaults through the real pack store and layered reader, the
// one-cost-pack rule, and the prompt the owner approves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNimbusCostFromConfigDir } from "../config/cost-toml.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "../config/layered-config.ts";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import {
  createPackLayerStore,
  PackLayerRefusedError,
  type PackLayerStore,
} from "./pack-layer-store.ts";
import { diffPacks, renderPackPrompt } from "./pack-prompt.ts";

const FINOPS = BUNDLED_PACKS.get("finops");
if (FINOPS === undefined) throw new Error("the finops pack is not bundled");
const OTHER_COST = '[[cost.rule]]\nmatch = { provider = "aws" }\nset = { product = "platform" }\n';

let dir: string;
beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-cost-"));
});
afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

function wired(): PackLayerStore {
  const store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs: store });
  return store;
}

function refusal(fn: () => unknown): PackLayerRefusedError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackLayerRefusedError);
    return err as PackLayerRefusedError;
  }
  throw new Error("expected a PackLayerRefusedError");
}

describe("the finops pack through the layered reader", () => {
  test("supplies two rules, one channel-less report and the internal envs", () => {
    wired().setPackLayer("default", "finops", FINOPS.defaults);
    const cfg = loadNimbusCostFromConfigDir(dir);
    expect(cfg.error).toBeNull();
    expect(cfg.reportsError).toBeNull();
    expect(cfg.rules).toHaveLength(2);
    expect(cfg.reports.map((r) => [r.name, r.channels.length])).toEqual([["prod-weekly", 0]]);
    expect(cfg.internalEnvs).toEqual(["ci", "dev", "test", "staging"]);
  });

  test("the owner's own rules and envs replace the pack's whole set; their channel joins the pack's report", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[cost]\ninternal_envs = ["ci"]\n\n${OTHER_COST}\n[[cost.report.channel]]\nreport = "prod-weekly"\nkind = "slack"\nto = "C0123ABC"\nformat = "text"\ntemplate = "{total}"\n`,
    );
    wired().setPackLayer("default", "finops", FINOPS.defaults);
    const cfg = loadNimbusCostFromConfigDir(dir);
    expect(cfg.error).toBeNull();
    expect(cfg.rules).toHaveLength(1);
    expect(cfg.internalEnvs).toEqual(["ci"]);
    expect(cfg.reports.map((r) => [r.name, r.channels.length])).toEqual([["prod-weekly", 1]]);
  });

  test("an owner [[cost.report]] replaces the pack's reports, so a channel naming the pack's report is refused", () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[[cost.report]]\nname = "mine"\nscope = { product = "checkout" }\nperiod = "month"\n\n[[cost.report.channel]]\nreport = "prod-weekly"\nkind = "slack"\nto = "C0123ABC"\nformat = "text"\ntemplate = "{total}"\n',
    );
    wired().setPackLayer("default", "finops", FINOPS.defaults);
    const cfg = loadNimbusCostFromConfigDir(dir);
    expect(cfg.reports).toEqual([]);
    expect(cfg.reportsError).toContain("prod-weekly");
  });
});

describe("only one installed pack may set cost defaults", () => {
  test("a second cost pack conflicts; the same pack updating itself does not; a non-cost pack does not", () => {
    const store = wired();
    store.setPackLayer("default", "finops", FINOPS.defaults);
    const err = refusal(() => store.setPackLayer("default", "other", OTHER_COST));
    expect(err.reason).toBe("conflict");
    expect(err.problems).toEqual(["cost defaults are also set by pack finops"]);
    expect(() =>
      store.setPackLayer("default", "finops", `${FINOPS.defaults}\n${OTHER_COST}`),
    ).not.toThrow();
    expect(() => store.setPackLayer("default", "fleet", "[fleet]\nenabled = true\n")).not.toThrow();
  });
});

describe("the prompt the owner approves", () => {
  const base = {
    source: { kind: "bundled" } as const,
    scalars: [],
    visibleAgents: [],
    sourceMappings: [],
    jobs: [],
    connectors: [],
  };

  test("install lists the cost defaults and prints the full text", () => {
    const out = renderPackPrompt({ ...base, manifest: FINOPS, mode: "install" });
    expect(out).toContain("Cost defaults:\n  internal environments: ci, dev, test, staging");
    expect(out).toContain("it sends nothing until you add a [[cost.report.channel]] for it");
    expect(out).toContain(`Full config text:\n${FINOPS.defaults}`);
  });

  test("a pack with no cost defaults shows no cost section", () => {
    const out = renderPackPrompt({
      ...base,
      manifest: { ...FINOPS, defaults: "[fleet]\nenabled = true\n" },
      mode: "install",
    });
    expect(out).not.toContain("Cost defaults:");
  });

  test("an update that changes only the cost tables says so; a comment edit does not", () => {
    const next = {
      ...FINOPS,
      version: "1.1.0",
      defaults: FINOPS.defaults.replace('"staging"', '"qa"'),
    };
    const diff = diffPacks(FINOPS, next);
    expect(diff.cost).toBe(true);
    const out = renderPackPrompt({ ...base, manifest: next, mode: "update", diff });
    expect(out).toContain("Cost defaults:\n  changed:\n  internal environments: ci, dev, test, qa");
    expect(diffPacks(FINOPS, { ...FINOPS, defaults: `# note\n${FINOPS.defaults}` }).cost).toBe(
      false,
    );
  });
});

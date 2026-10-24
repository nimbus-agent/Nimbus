import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONNECTOR_CATALOG_META } from "../catalog/connector-catalog-meta.ts";
import { forgetLayeredConfigForTests, initLayeredConfig } from "../config/layered-config.ts";
import { CONNECTOR_SERVICE_IDS, UNBUNDLED_CONNECTOR_IDS } from "../connectors/connector-catalog.ts";
import { GATEWAY_SYNCABLE_SERVICE_IDS } from "../connectors/gateway-syncable-ids.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { CatalogRpcError, dispatchCatalogRpc } from "./catalog-rpc.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

function setup(files: Record<string, string> = {}): { db: Database; configDir: string } {
  const db = openMigratedMemoryDb();
  const configDir = mkdtempSync(join(tmpdir(), "nimbus-catalog-rpc-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(configDir, name), text);
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  cleanups.push(() => forgetLayeredConfigForTests(configDir));
  cleanups.push(() => db.close());
  return { db, configDir };
}

describe("dispatchCatalogRpc", () => {
  test("catalog.list returns 17 agents and every builtin connector", () => {
    const ctx = setup();
    initLayeredConfig(ctx.configDir);
    const out = dispatchCatalogRpc("catalog.list", {}, ctx);
    if (out.kind !== "hit") throw new Error("expected a hit");
    expect(out.value.agents).toHaveLength(17);
    expect(out.value.agents.every((a) => a.visible)).toBe(true);
    const builtins = out.value.connectors.filter((c) => c.kind === "builtin").map((c) => c.id);
    expect([...builtins].sort()).toEqual(Object.keys(CONNECTOR_CATALOG_META).sort());
    const unbundled: ReadonlySet<string> = new Set(UNBUNDLED_CONNECTOR_IDS);
    const bundled = [
      ...CONNECTOR_SERVICE_IDS.filter((id) => !unbundled.has(id)),
      ...GATEWAY_SYNCABLE_SERVICE_IDS,
    ].sort();
    expect([...builtins].sort()).toEqual(bundled);
    for (const id of UNBUNDLED_CONNECTOR_IDS) expect(builtins).not.toContain(id);
    expect(out.value.visibility.basis).toBe("all");
  });

  test("rejects params", () => {
    const ctx = setup();
    for (const p of [{ x: 1 }, [], "a", 3]) {
      expect(() => dispatchCatalogRpc("catalog.list", p, ctx)).toThrow(CatalogRpcError);
      try {
        dispatchCatalogRpc("catalog.list", p, ctx);
      } catch (e) {
        expect(e).toMatchObject({ rpcCode: -32602, message: "catalog.list takes no params" });
      }
    }
    for (const p of [undefined, null, {}]) {
      expect(dispatchCatalogRpc("catalog.list", p, ctx).kind).toBe("hit");
    }
  });

  test("skips other methods", () => {
    const ctx = setup();
    expect(dispatchCatalogRpc("catalog.get", {}, ctx)).toEqual({ kind: "skip" });
    expect(dispatchCatalogRpc("agents.list", {}, ctx)).toEqual({ kind: "skip" });
  });

  test("visible follows a profile's show over the base's hide", () => {
    const ctx = setup({
      "nimbus.toml": '[agents]\nhide = ["standup", "glossary"]\n',
      "nimbus.work.toml": '[agents]\nshow = ["standup"]\n',
    });
    initLayeredConfig(ctx.configDir, { explicitProfile: "work" });
    const out = dispatchCatalogRpc("catalog.list", undefined, ctx);
    if (out.kind !== "hit") throw new Error("expected a hit");
    const visible = new Map(out.value.agents.map((a) => [a.name, a.visible]));
    expect(visible.get("standup")).toBe(true);
    expect(visible.get("glossary")).toBe(false);
    expect(visible.get("oncall")).toBe(true);
  });
});

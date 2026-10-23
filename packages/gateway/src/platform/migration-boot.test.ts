import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CONTINUITY_TABLE } from "../extensions/continuity/continuity-table.ts";
import { BUILTIN_REGISTRY } from "../extensions/registry/builtin-registry.ts";
import { resolveMigrationComposition, startMigrationBootEvaluation } from "./migration-boot.ts";

const FIXTURE_BUILTIN = { url: "/fixture/registry", rootKey: "AAAA" };
const FIXTURE_ENTRY = {
  legacyServiceId: "fixturewise",
  extensionId: "com.example.fixturewise",
  publisherKey: "k",
  sourceRootFingerprint: "f",
  credentials: { token: "fixturewise.token" },
  expectedPermissions: { network: [], read: [], write: [] },
  itemTypes: ["highlight"],
};

describe("ruling B1: the built-in registry and continuity table are injected, never configured", () => {
  test("the production assemble path (no composition options) resolves the baked defaults", () => {
    const resolved = resolveMigrationComposition(undefined);
    expect(resolved.builtin).toBe(BUILTIN_REGISTRY);
    expect(resolved.continuityTable).toBe(CONTINUITY_TABLE);
    // And the baked defaults are the real official registry and the one Readwise binding.
    expect(BUILTIN_REGISTRY?.url).toBe("https://nimbus-agent.github.io/nimbus-mcp-servers/");
    expect(BUILTIN_REGISTRY?.rootKey).toBe("tBHSfVjFZzyMoSVR69FbZfMyUstbLdUcfGwHKIaY/qA=");
    expect(CONTINUITY_TABLE.map((e) => e.extensionId)).toEqual(["com.nimbus.readwise"]);
    expect(resolveMigrationComposition({})).toEqual(resolved);
    expect(resolveMigrationComposition({ migration: {} })).toEqual(resolved);
  });

  test("a runner's fixture is passed through as ONE value, and an explicit null stays null", () => {
    const r = resolveMigrationComposition({
      migration: { builtin: FIXTURE_BUILTIN, continuityTable: [FIXTURE_ENTRY] },
    });
    expect(r.builtin).toBe(FIXTURE_BUILTIN);
    expect(r.continuityTable).toEqual([FIXTURE_ENTRY]);
    expect(resolveMigrationComposition({ migration: { builtin: null } }).builtin).toBeNull();
  });

  test("every production entry point calls assemblePlatformServices with the paths alone", () => {
    for (const os of ["win32", "darwin", "linux"]) {
      const src = readFileSync(join(import.meta.dir, `${os}.ts`), "utf8");
      const calls = [...src.matchAll(/assemblePlatformServices\(([^)]*)\)/g)].map((m) => m[1]);
      expect(calls, os).toEqual(["paths"]);
    }
  });

  test("assemble resolves ONE composition and threads it to every binding consumer", () => {
    // Comments stripped, so prose naming a constant cannot satisfy (or trip) a pin.
    const src = readFileSync(join(import.meta.dir, "assemble.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src.match(/resolveMigrationComposition\(/g)).toHaveLength(1);
    expect(src).toMatch(/const migration = resolveMigrationComposition\(composition\);/);
    // The registry fetch, the registrar, the spawn verifier, the credential resolver, the purge
    // and the engine all read the same `migration` value.
    expect(src).toMatch(/builtin: migration\.builtin,/);
    expect(src).toMatch(/table: migration\.continuityTable,/);
    expect(src).toMatch(/continuityTable: migration\.continuityTable,/);
    expect(src).toMatch(/createExtensionCredentialsResolver\(db, migration\.continuityTable\)/);
    expect(src).toMatch(/table: migration\.continuityTable \}/);
    expect(src).toMatch(/composition: migration,/);
    // Nothing in assemble names the baked constants directly, so no consumer can bypass it.
    expect(src).not.toMatch(/\bCONTINUITY_TABLE\b/);
    expect(src).not.toMatch(/\bBUILTIN_REGISTRY\b/);
    // The IPC server gets the same value (C7): `extension.approveRun`, `extension.credentialSet` /
    // `credentialStatus` and `connector.remove`'s extension-backed refusal bind through it.
    const ipcOpts = src.match(/const ipcOpts: [^=]*= \{[\s\S]*?\n {2}\};/)?.[0] ?? "";
    expect(ipcOpts).toMatch(/\bcontinuityTable: migration\.continuityTable,/);
  });

  test("the E2E runner never lets a table-only fixture fall back to the real built-in registry", () => {
    // `{ builtin: null, ...fixture }`: a fixture naming `builtin` still wins; one that sets only
    // `continuityTable` gets NO built-in, never the baked github.io one.
    const runner = readFileSync(
      join(import.meta.dir, "..", "..", "test", "e2e", "_fixtures", "gateway-runner.ts"),
      "utf8",
    );
    expect(runner).toMatch(/migration: \{ builtin: null, \.\.\.migrationFixture \}/);
    expect(
      resolveMigrationComposition({ migration: { builtin: null, continuityTable: [] } }).builtin,
    ).toBeNull();
  });

  test("the IPC server threads the composed table to every IPC binding consumer (C7)", () => {
    const strip = (rel: string): string =>
      readFileSync(join(import.meta.dir, "..", rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const dispatchers = strip(join("ipc", "server", "dispatchers.ts"));
    for (const callee of ["dispatchAutomationRpc", "dispatchConnectorRpc"]) {
      const at = dispatchers.indexOf(`await ${callee}({`);
      expect(at, callee).toBeGreaterThan(-1);
      const args = dispatchers.slice(at, dispatchers.indexOf("});", at));
      expect(args, callee).toMatch(/continuityTable: ctx\.options\.continuityTable/);
    }
    const automation = strip(join("ipc", "automation-rpc.ts"));
    const argsOf = (callee: string): string => {
      const at = automation.indexOf(`await ${callee}(`);
      expect(at, callee).toBeGreaterThan(-1);
      return automation.slice(at, automation.indexOf(");", at));
    };
    expect(argsOf("approveExtensionRun")).toMatch(/\.\.\.continuityTableOf\(ctx\)/);
    // Both credential methods take their binding lookups from ONE helper, which hands the composed
    // table to the trust check AND to the live re-derivation of the binding.
    for (const callee of ["setExtensionCredential", "extensionCredentialStatus"]) {
      expect(argsOf(callee), callee).toMatch(/\.\.\.credentialReadDeps\(ctx\)/);
    }
    const readDepsAt = automation.indexOf("function credentialReadDeps(");
    expect(readDepsAt).toBeGreaterThan(-1);
    const readDeps = automation.slice(readDepsAt, automation.indexOf("\n}\n", readDepsAt));
    expect(readDeps).toMatch(/\.\.\.continuityTableOf\(ctx\)/);
    expect(readDeps).toMatch(
      /liveCredentials: \(x\) => currentRunCredentials\(ctx\.db, x, ctx\.continuityTable\)/,
    );
    // `continuityTableOf` forwards the composed table itself, never a default of its own.
    const tableOfAt = automation.indexOf("function continuityTableOf(");
    expect(tableOfAt).toBeGreaterThan(-1);
    expect(automation.slice(tableOfAt, automation.indexOf("\n}\n", tableOfAt))).toMatch(
      /ctx\.continuityTable === undefined \? \{\} : \{ continuityTable: ctx\.continuityTable \}/,
    );
    expect(automation).toMatch(/continuityTable: options\.continuityTable/);
    const connectorRpc = strip(join("ipc", "connector-rpc.ts"));
    expect(connectorRpc).toMatch(/\{ continuityTable \}/);
    const removal = strip(join("ipc", "connector-rpc-handlers", "removal.ts"));
    expect(removal).toMatch(/extensionIdBackingServiceId\(db, s, ctx\.continuityTable\)/);
    // No IPC module names the baked constants: the composition is the only source.
    for (const src of [dispatchers, automation, connectorRpc, removal]) {
      expect(src).not.toMatch(/\bCONTINUITY_TABLE\b/);
    }
  });
});

describe("boot evaluation", () => {
  const logger = () => {
    const warnings: unknown[] = [];
    return { warnings, log: { warn: (...a: unknown[]) => warnings.push(a) } };
  };

  test("runs once on a real gateway", async () => {
    let n = 0;
    const { log } = logger();
    await startMigrationBootEvaluation({ evaluate: async () => void n++ }, false, log);
    expect(n).toBe(1);
  });

  test("is skipped when demo-rooted (I41)", () => {
    let n = 0;
    const { log } = logger();
    expect(
      startMigrationBootEvaluation({ evaluate: async () => void n++ }, true, log),
    ).toBeUndefined();
    expect(n).toBe(0);
  });

  test("a rejecting evaluate is logged and never blocks or fails boot", async () => {
    const { warnings, log } = logger();
    const p = startMigrationBootEvaluation(
      { evaluate: () => Promise.reject(new Error("registry offline")) },
      false,
      log,
    );
    await expect(p).resolves.toBeUndefined();
    expect(JSON.stringify(warnings)).toContain("registry offline");
  });

  test("a synchronously throwing evaluate is logged too", async () => {
    const { warnings, log } = logger();
    const p = startMigrationBootEvaluation(
      {
        evaluate: () => {
          throw new Error("boom");
        },
      },
      false,
      log,
    );
    await expect(p).resolves.toBeUndefined();
    expect(JSON.stringify(warnings)).toContain("boom");
  });
});

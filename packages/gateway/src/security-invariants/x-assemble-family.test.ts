import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { asm, readAssembleFamily } from "../../test/helpers/security-invariants.ts";

/**
 * Whole-assembly pins. `platform/assemble.ts` keeps `assemblePlatformServices` (the composition
 * root); the boot helpers it calls live in `platform/assemble/`. A pin that says "exactly one" or
 * "nowhere else" about the assembly has to count over every file of that family, or moving a call
 * from one file to another would pass it. A pin about WHERE a piece of wiring sits reads that one
 * module and lives in the invariant test of the defence it belongs to (I15, I22, I23, I41, I43...).
 */
describe("platform/assemble family: counts and absences hold across every file", async () => {
  const family = Object.entries(await readAssembleFamily());
  const code = family.map(([, text]) => stripComments(text)).join("\n");
  const count = (re: RegExp): number => code.match(re)?.length ?? 0;

  test("the family is the root plus its helper modules, none of them empty", () => {
    expect(family.length).toBeGreaterThan(10);
    expect(family.map(([rel]) => rel)).toContain("packages/gateway/src/platform/assemble.ts");
    for (const [rel, text] of family) expect(text.trim().length, rel).toBeGreaterThan(0);
  });

  test("I22: connectorAllowPredicate is imported and used once, in the policy boot", () => {
    expect(count(/\bconnectorAllowPredicate\s*\(/g)).toBe(1);
    expect(count(/\bconnectorAllowPredicate\b/g)).toBe(2);
  });

  test("I22: each off-mesh door is booted by exactly one call", () => {
    for (const name of [
      "buildTeamCredentialContexts",
      "bootFederationIntoIpcOpts",
      "bootChatopsIntoAssembly",
      "bootPolicyGateWithConnectorAllowlist",
    ]) {
      expect(count(new RegExp(`(?<!function )${name}\\(`, "g")), name).toBe(1);
    }
  });

  test("I23: the watcher notice is settled once and has three settle branches", () => {
    expect(count(/watcherChat\.settle\(/g)).toBe(3);
    expect(count(/settleWatcherChatops\(watcherChat, chatopsBoot\)/g)).toBe(1);
  });

  test("I41: one scheduler, started once, one slot source and one runtime predicate", () => {
    expect(count(/new SyncScheduler\(/g)).toBe(1);
    expect(count(/syncScheduler\.start\(\);/g)).toBe(1);
    expect(count(/createExtensionSlotSource\(/g)).toBe(1);
    expect(count(/isExtensionRuntimeEnabled\(/g)).toBe(1);
  });

  test("I43: the extension slot source exists only when the runtime switch is on", async () => {
    const scheduler = await asm.code("assemble/scheduler-mesh.ts");
    expect(scheduler).toMatch(
      /const extensionSlots = extensionRuntimeEnabled\s*\?\s*createExtensionSlotSource\(/,
    );
  });

  test("I41: one updater wiring, one telemetry flush, one auto-update daemon", () => {
    expect(count(/(?<!function )wireUpdaterIntoIpc\(/g)).toBe(1);
    expect(count(/startTelemetryFlushScheduler\(/g)).toBe(1);
    expect(count(/createAutoUpdateRuntime\(/g)).toBe(1);
  });

  test("I35: a computer-use consent broker is never given a broadcast poster", () => {
    expect(code).not.toMatch(/cu(?:Envelope|Action)Consent\.setBroadcast\(/);
  });

  test("I58: the retired proposability table names are back nowhere", () => {
    expect(code).not.toMatch(
      /classifyActionType|ACTION_PROPOSABILITY|PROPOSABLE_WRITE_TOOLS|createActionDestinationRefusal/,
    );
  });

  test("I15: no sandboxed spawn is given the data or config directory as its working directory", () => {
    expect(code).not.toMatch(/sandboxCwd:\s*paths\.dataDir/);
    expect(code).not.toMatch(/\bcwd:\s*paths\.(dataDir|configDir)/);
  });

  test("I38: exactly one FleetRemoteBudget is constructed", () => {
    expect(count(/createFleetRemoteBudget\s*\(/g)).toBe(1);
  });
});

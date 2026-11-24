import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";

// I57 (a), extended by owner ruling 9 (`nimbus incident investigate --live`): incident assembly stays read-only over
// the index; the ONE live read lives outside `incident/`, starts only from the terminal on the owner's request, goes
// through the executor's gate as a read action (audit row, I29 egress row), is correlated, bounded, never stored and
// reaches a model only on `--synthesize`, inside the I11 envelope. Behaviour is pinned in
// `investigation/investigation-live.test.ts` and `ipc/investigation-live-rpc.test.ts`; this file pins the wiring.
describe("I57 (a) - owner ruling 9: the live investigation read is the owner's, gated, ledgered and never part of assembly", () => {
  const LIVE = "packages/gateway/src/investigation/investigation-live.ts";

  test("1: static D46(h) holds over the real tree and the live module is anchored", async () => {
    const { checkInvestigateLiveConfinement, RULE_ANCHORS } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const { iterateSourceFiles } = await import("../../../../scripts/structure-audit/lib.ts");
    const files: { relPath: string; contents: string }[] = [];
    for await (const f of iterateSourceFiles())
      files.push({ relPath: f.relPath, contents: f.contents });
    expect(checkInvestigateLiveConfinement(files)).toEqual([]);
    expect(files.some((f) => f.relPath === LIVE)).toBe(true);
    expect(RULE_ANCHORS).toContain(LIVE);
  });

  test("2: nothing under incident/ (assembly) names the live module, and the index investigation has no executor or live field of its own", async () => {
    for (const f of await readDirFiles("packages/gateway/src/incident")) {
      if (f.rel.endsWith(".test.ts")) continue;
      expect(stripComments(f.contents), f.rel).not.toMatch(/investigation-live/);
    }
    const inv = stripComments(await read("packages/gateway/src/incident/investigate.ts"));
    // `live` is an optional type member only: the index reader never sets it, never takes an executor.
    expect(inv).not.toMatch(/\bmakeExecutor\b|\bexecute\s*\(|\bfetch\s*\(/);
    expect(inv).not.toMatch(/\blive\s*:\s*[{[]/);
  });

  test("3: the read is a gated action, never a direct call: no connector import, no fetch, the type is the dispatcher's own-service read, linked to the record", async () => {
    const src = stripComments(await read(LIVE));
    expect(src).not.toMatch(
      /\bfetch\s*\(|\bBun\.spawn\b|createConnectorDispatcher|\.dispatch\s*\(/,
    );
    expect(src).toMatch(/\.execute\(action\)/);
    expect(src).toMatch(/investigateReadActionType\("sentry"\)/);
    expect(src).toMatch(/incident:\s*link/);
    // The reader builds no origin, proposer or provenance: it is the owner's own linked action (I20, I55).
    expect(src).not.toMatch(/\borigin\s*:|\bproposer\s*:|\bprovenance\s*:/);
    const registry = stripComments(await read("packages/gateway/src/connectors/registry.ts"));
    expect(registry).toMatch(/isOwnServiceReadStepType\(actionType\)/);
    const reads = stripComments(await read("packages/gateway/src/engine/investigate-read.ts"));
    expect(reads).toMatch(
      /isRunbookReadActionType\(actionType\) \|\| isInvestigateReadActionType\(actionType\)/,
    );
  });

  test("4: the live block is never stored: the module has no write verb, no store import and no record upsert", async () => {
    const src = stripComments(await read(LIVE));
    expect(src).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\b|\bdbRun\b|\bdbExec\b|\bupsertIncidentRecord\b/,
    );
    expect(src).not.toMatch(/\.run\s*\(\s*["'`](?:INSERT|UPDATE|DELETE)/i);
  });

  test("5: only a `cli` connection starts it; the methods are off the LAN (I5) and the renderer (I7)", async () => {
    const rpc = stripComments(await read("packages/gateway/src/ipc/investigation-rpc.ts"));
    expect(rpc).toMatch(/if \(kind !== "cli"\)/);
    expect(rpc).toMatch(/if \(wantsLive\) requireLiveKind\(caller\.kind\);/);
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["investigateLive", "investigateSynthesize", "investigate"]) {
      expect(rust, m).not.toContain(`"incident.${m}"`);
    }
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const m of ["investigateLive", "investigateSynthesize"]) {
      expect(() =>
        checkLanMethodAllowed(`incident.${m}`, { peerId: "peer:x", writeAllowed: true }),
      ).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    }
  });

  test("6: the live investigator is wired on the gateway options once, from the same executor factory as remediation, and no schedule, workflow, ChatOps or agent-door module names it", async () => {
    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(assemble.match(/ipcOpts\.investigationLive = createLiveInvestigator\(/g)?.length).toBe(
      1,
    );
    expect(assemble).toMatch(/createLiveInvestigator\(\{ db, makeExecutor: incidentExecutor \}\)/);
    for (const dir of ["automation", "chatops", "mcp-sink", "fleet", "briefing", "oncall-push"]) {
      for (const f of await readDirFiles(`packages/gateway/src/${dir}`)) {
        if (f.rel.endsWith(".test.ts")) continue;
        expect(stripComments(f.contents), f.rel).not.toMatch(
          /investigationLive|createLiveInvestigator|investigation-live/,
        );
      }
    }
  });
});

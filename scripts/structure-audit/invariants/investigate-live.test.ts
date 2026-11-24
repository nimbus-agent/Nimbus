// Static rule D46(h) (owner ruling 9, I57 (a) extension): the live investigation read lives in one module outside
// `incident/`. Each clause is red-proved on a fixture, and the real tree is clean with the module anchored.
import { describe, expect, test } from "bun:test";
import { iterateSourceFiles } from "../lib.ts";
import type { FileEntry } from "./_shared.ts";
import { checkInvestigateLiveConfinement } from "./investigate-live.ts";
import { RULE_ANCHORS } from "./rule-anchors.ts";

const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
const SRC = "packages/gateway/src/";
const LIVE = `${SRC}investigation/investigation-live.ts`;
const rules = (files: FileEntry[]): string[] =>
  checkInvestigateLiveConfinement(files).map((v) => v.rule);

const GOOD: FileEntry[] = [
  file(
    LIVE,
    [
      'import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";',
      'import { beforeReplyJson } from "../connectors/connector-writes/before-select.ts";',
      'import { investigateReadActionType } from "../engine/investigate-read.ts";',
      "export function createLiveInvestigator() {}",
      'const a = { type: investigateReadActionType("sentry") };',
    ].join("\n"),
  ),
  file(
    `${SRC}engine/investigate-read.ts`,
    'const S = ".investigate.read"; export function investigateReadActionType() {}',
  ),
  file(`${SRC}platform/assemble.ts`, "ipcOpts.investigationLive = createLiveInvestigator({ db });"),
  file(`${SRC}ipc/server/options.ts`, "investigationLive?: LiveInvestigator;"),
  file(`${SRC}ipc/server/dispatchers/ops-rpcs.ts`, "live: ctx.options.investigationLive,"),
  file(`${SRC}incident/investigate.ts`, "// see the live module\nexport const x = 1;"),
];

describe("D46(h) - the live investigation read is confined", () => {
  test("the control: the allowed shape is clean", () => {
    expect(rules(GOOD)).toEqual([]);
  });

  test("FAILS when another module builds or spells the investigate-read type", () => {
    expect(
      rules([
        ...GOOD,
        file(`${SRC}runbook/x.ts`, 'const a = { type: investigateReadActionType("jira") };'),
      ]),
    ).toEqual(["investigate-read-type-confined"]);
    expect(
      rules([...GOOD, file(`${SRC}engine/agent.ts`, 'const t = s + ".investigate.read";')]),
    ).toEqual(["investigate-read-type-confined"]);
  });

  test("FAILS when the reader is wired anywhere but its wiring files", () => {
    expect(
      rules([
        ...GOOD,
        file(`${SRC}automation/workflow-runner.ts`, "createLiveInvestigator({ db });"),
      ]),
    ).toEqual(["investigate-live-confined"]);
    expect(
      rules([...GOOD, file(`${SRC}chatops/x.ts`, "const l = ctx.options.investigationLive;")]),
    ).toEqual(["investigate-live-confined"]);
  });

  test("FAILS when incident assembly (or its render) names the live module", () => {
    expect(
      rules([
        ...GOOD,
        file(
          `${SRC}incident/assemble.ts`,
          'import { x } from "../investigation/investigation-live.ts";',
        ),
      ]),
    ).toEqual(["incident-live-import"]);
    expect(
      rules([
        ...GOOD,
        file(
          `${SRC}agents/_lib/incident-render.ts`,
          'import("../../investigation/investigation-live.ts");',
        ),
      ]),
    ).toEqual(["incident-live-import"]);
  });

  test("FAILS when the live module reaches chatops, egress, federation or share, or the network", () => {
    for (const seg of ["chatops", "egress", "federation", "share"]) {
      expect(rules([file(LIVE, `import { x } from "../${seg}/y.ts";`)])).toContain(
        "investigate-live-forbidden-import",
      );
    }
    expect(rules([file(LIVE, 'const r = await fetch("https://sentry.io");')])).toContain(
      "investigate-live-no-network",
    );
    expect(rules([file(LIVE, 'import https from "node:https";')])).toContain(
      "investigate-live-no-network",
    );
    // A connectors VALUE import other than the two pure helpers is refused too.
    expect(
      rules([file(LIVE, 'import { createConnectorDispatcher } from "../connectors/registry.ts";')]),
    ).toContain("investigate-live-forbidden-import");
  });

  test("tests and comments are exempt", () => {
    expect(
      rules([
        ...GOOD,
        file(
          `${SRC}ipc/x.test.ts`,
          "createLiveInvestigator(); investigationLive; investigateReadActionType;",
        ),
        file(
          `${SRC}ipc/y.ts`,
          "// investigationLive, createLiveInvestigator and .investigate.read in a comment",
        ),
      ]),
    ).toEqual([]);
  });

  test("the real tree is clean and the module is anchored", async () => {
    const files: FileEntry[] = [];
    for await (const f of iterateSourceFiles())
      files.push({ relPath: f.relPath, contents: f.contents });
    expect(RULE_ANCHORS).toContain(LIVE);
    expect(files.some((f) => f.relPath === LIVE)).toBe(true);
    expect(checkInvestigateLiveConfinement(files)).toEqual([]);
  });
});

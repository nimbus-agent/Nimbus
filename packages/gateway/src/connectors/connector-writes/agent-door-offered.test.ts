import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { serviceOf } from "../../engine/service-of.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  type AgentOfferFacts,
  agentDoorPolicyAllows,
  agentDoorRow,
  agentOffered,
} from "./agent-door.ts";
import {
  modelWriteServices,
  OBSIDIAN_APPEND_TOOL_ID,
  setModelWriteEnablement,
  writesEnabledBy,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import {
  createModelWriteToolSource,
  enabledAndOfferable,
  scopeAvailable,
} from "./model-write-source.ts";
import { scopeGatedReason } from "./scope-gated.ts";
import type { ConnectorWriteRow } from "./types.ts";

const open = { capabilitiesDisabled: new Set<string>() };
const BASE: AgentOfferFacts = {
  enablement: undefined,
  approval: { suspendedAt: null },
  enforced: open,
  hasWorkdir: true,
  hasK8sPair: true,
  obsidianModelGrant: true,
};
const factsFor = (
  row: ConnectorWriteRow,
  over: Partial<AgentOfferFacts> = {},
): AgentOfferFacts => ({
  ...BASE,
  enablement: { service: serviceOf(row.actionType), maxWave: 4 },
  ...over,
});
const reachable = CONNECTOR_WRITE_ROWS.filter((r) => agentDoorRow(r.actionType) === r);

describe("agentOffered (the second door's predicate, D-1)", () => {
  test("parity over every row: the shared conditions AND the door approval AND the four door-specific ones", () => {
    const enablements = (row: ConnectorWriteRow) => [
      undefined,
      { service: serviceOf(row.actionType), maxWave: 2 as const },
      { service: serviceOf(row.actionType), maxWave: 3 as const },
      { service: serviceOf(row.actionType), maxWave: 4 as const },
      { service: "someotherservice", maxWave: 4 as const },
    ];
    const approvals = [undefined, { suspendedAt: null }, { suspendedAt: 5 }];
    const policies = [
      undefined,
      open,
      { capabilitiesDisabled: new Set(["mcp_action"]) },
      { capabilitiesDisabled: new Set(["connector_write_model_access"]) },
    ];
    let compared = 0;
    for (const row of CONNECTOR_WRITE_ROWS) {
      for (const enablement of enablements(row)) {
        for (const approval of approvals) {
          for (const enforced of policies) {
            for (const hasWorkdir of [true, false]) {
              for (const hasK8sPair of [true, false]) {
                for (const obsidianModelGrant of [true, false]) {
                  const f: AgentOfferFacts = {
                    enablement,
                    approval,
                    enforced,
                    hasWorkdir,
                    hasK8sPair,
                    obsidianModelGrant,
                  };
                  const want =
                    enabledAndOfferable(enablement, row) &&
                    approval !== undefined &&
                    approval.suspendedAt === null &&
                    agentDoorPolicyAllows(enforced) &&
                    agentDoorRow(row.actionType) === row &&
                    scopeAvailable(row, hasWorkdir, hasK8sPair) &&
                    scopeGatedReason(row.toolId, undefined) === undefined &&
                    (row.toolId !== OBSIDIAN_APPEND_TOOL_ID || obsidianModelGrant);
                  if (agentOffered(row, f) !== want) {
                    throw new Error(`${row.toolId} diverges for ${JSON.stringify(f)}`);
                  }
                  compared++;
                }
              }
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(50_000);
  });

  test("slack_message_post_dm is the only model-offerable row never offered to an agent (derived)", () => {
    const never = CONNECTOR_WRITE_ROWS.filter(
      (r) => isModelOfferableRow(r) && !agentOffered(r, factsFor(r)),
    ).map((r) => r.toolId);
    expect(never).toEqual(["slack_message_post_dm"]);
    expect(reachable.filter((r) => isModelOfferableRow(r)).length).toBe(108);
  });

  test("each conjunct alone flips an offered row to false", () => {
    const row = reachable.find((r) => r.wave === 3 && isModelOfferableRow(r)) as ConnectorWriteRow;
    const service = serviceOf(row.actionType);
    expect(agentOffered(row, factsFor(row))).toBe(true);
    expect(agentOffered(row, factsFor(row, { enablement: undefined }))).toBe(false);
    expect(agentOffered(row, factsFor(row, { enablement: { service, maxWave: 2 } }))).toBe(false);
    expect(agentOffered(row, factsFor(row, { enablement: { service: "other", maxWave: 4 } }))).toBe(
      false,
    );
    expect(agentOffered(row, factsFor(row, { approval: undefined }))).toBe(false);
    expect(agentOffered(row, factsFor(row, { approval: { suspendedAt: 9 } }))).toBe(false);
    expect(agentOffered(row, factsFor(row, { enforced: undefined }))).toBe(false);
    expect(
      agentOffered(
        row,
        factsFor(row, { enforced: { capabilitiesDisabled: new Set(["mcp_action"]) } }),
      ),
    ).toBe(false);
    expect(
      agentOffered(
        row,
        factsFor(row, {
          enforced: { capabilitiesDisabled: new Set(["connector_write_model_access"]) },
        }),
      ),
    ).toBe(false);
  });

  test("the directory rows need their scope, the Obsidian append the model grant, a scope-gated write its scope", () => {
    const tf = reachable.find(
      (r) => r.bound?.prepare.settle === "iac-terraform",
    ) as ConnectorWriteRow;
    expect(agentOffered(tf, factsFor(tf, { hasWorkdir: false }))).toBe(false);
    expect(agentOffered(tf, factsFor(tf))).toBe(true);
    const kube = reachable.find(
      (r) => serviceOf(r.actionType) === "kubernetes",
    ) as ConnectorWriteRow;
    expect(agentOffered(kube, factsFor(kube, { hasK8sPair: false }))).toBe(false);
    const obs = reachable.find((r) => r.toolId === OBSIDIAN_APPEND_TOOL_ID) as ConnectorWriteRow;
    expect(agentOffered(obs, factsFor(obs, { obsidianModelGrant: false }))).toBe(false);
    expect(agentOffered(obs, factsFor(obs))).toBe(true);
    const gm = reachable.find((r) => r.toolId === "gmail_thread_archive") as ConnectorWriteRow;
    expect(agentOffered(gm, factsFor(gm, { grantedScopes: { gmail: "x" } }))).toBe(false);
    expect(agentOffered(gm, factsFor(gm))).toBe(true);
  });

  test("a never-offered row and an un-templated row are never offered", () => {
    const send = CONNECTOR_WRITE_ROWS.find(
      (r) => r.toolId === "gmail_message_send",
    ) as ConnectorWriteRow;
    expect(agentOffered(send, factsFor(send))).toBe(false);
    const { preview: _drop, ...rest } = reachable.find(
      (r) => r.wave === 2 && isModelOfferableRow(r),
    ) as ConnectorWriteRow;
    const plain: ConnectorWriteRow = rest;
    expect(isModelOfferableRow(plain)).toBe(false);
    expect(agentOffered(plain, factsFor(plain))).toBe(false);
  });

  test("where both doors approved a row and the door-specific conditions hold it equals the model's recheck", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 97);
    try {
      for (const wave of [2, 3, 4] as const) {
        for (const service of modelWriteServices()) {
          const rows = writesEnabledBy(service, wave);
          setModelWriteEnablement(
            db,
            service,
            wave,
            1,
            rows.map((r) => r.toolId),
          );
          const source = createModelWriteToolSource({
            db,
            enforcedPolicy: () => open as never,
            listServerTools: () => Promise.resolve(undefined),
            toolsEpoch: () => 0,
            warn: () => {},
            approvedWorkdirs: () => ["/w"],
            approvedK8sPairs: () => [{ context: "c", namespace: "n" }],
          });
          for (const r of rows) {
            if (agentDoorRow(r.actionType) !== r) continue;
            const offered = agentOffered(
              r,
              factsFor(r, { enablement: { service, maxWave: wave } }),
            );
            expect(offered, r.toolId).toBe(source.recheck(r));
          }
        }
      }
    } finally {
      db.close();
    }
  });
});

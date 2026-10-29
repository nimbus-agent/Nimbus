import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { consentDisplayPayload, NO_POLICY_OVERLAY, ToolExecutor } from "./executor.ts";
import type { PlannedAction } from "./types.ts";

/**
 * `extension.autoUpdate` with the packages and connectors it adds: the rendered plan (`planText`)
 * is the prompt body, so the Details line shows neither it nor the `addedPackages` and
 * `connectorRequirements` it renders (each package appears once). The desktop's structured details
 * keep both lists (it renders them itself), and the audit row keeps them without the plan text.
 */

const PLAN_TEXT = [
  "This update adds 1 package(s):",
  "  com.example.dep@1.2.0 (com.example.tool needs ^1.0.0) — registry main — publisher acme (6fb9a1c2d3e4f506…), unverified",
  "    network: api.example.com · read: none · write: none",
  "The added packages together: network: api.example.com · read: none · write: none",
  "Needs:",
  "  github: not connected — run: nimbus connector auth github",
].join("\n");

const BASE_PAYLOAD = {
  id: "com.example.tool",
  fromVersion: "1.0.0",
  toVersion: "1.1.0",
  sourceRegistry: "main",
};

const ADDED = [
  {
    id: "com.example.dep",
    version: "1.2.0",
    registry: "main",
    registryUrl: null,
    kind: "extension",
    permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
  },
];

const UNION = { network: ["api.example.com"], filesystem: { read: [], write: [] } };

const REQS = [
  {
    connector: "github",
    state: "not_connected",
    owner: { kind: "bundled" },
    fix: ["nimbus connector auth github"],
    interactive: true,
    requiredBy: ["com.example.dep"],
  },
];

function capture(): {
  prompts: string[];
  details: Array<Record<string, unknown> | undefined>;
  auditJson: string[];
  exec: ToolExecutor;
} {
  const prompts: string[] = [];
  const details: Array<Record<string, unknown> | undefined> = [];
  const auditJson: string[] = [];
  const exec = new ToolExecutor(
    {
      requestApproval: async (prompt: string, d?: Record<string, unknown>) => {
        prompts.push(prompt);
        details.push(d);
        return false;
      },
    },
    { recordAudit: (row: { actionJson: string }) => auditJson.push(row.actionJson) },
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
  return { prompts, details, auditJson, exec };
}

describe("extension.autoUpdate consent with the packages it adds", () => {
  const action: PlannedAction = {
    type: "extension.autoUpdate",
    payload: {
      ...BASE_PAYLOAD,
      addedPackages: ADDED,
      planPermissions: UNION,
      connectorRequirements: REQS,
      planText: PLAN_TEXT,
    },
  };

  test("the plan is the prompt body, and the Details line repeats none of it", async () => {
    const h = capture();
    await h.exec.execute(action);
    expect(h.prompts[0]).toBe(
      `Action requires your approval\n\nType: extension.autoUpdate\n\nDetails: ${JSON.stringify(BASE_PAYLOAD)}\n\n${PLAN_TEXT}`,
    );
  });

  test("the desktop's details keep the added packages and requirements, without the plan text", async () => {
    const h = capture();
    await h.exec.execute(action);
    expect(h.details[0]).toEqual({
      ...BASE_PAYLOAD,
      addedPackages: ADDED,
      planPermissions: UNION,
      connectorRequirements: REQS,
    });
    expect(consentDisplayPayload(action)).toEqual(h.details[0]);
  });

  test("the audit row keeps the added packages and requirements, never the plan text", async () => {
    const h = capture();
    await h.exec.execute(action);
    expect(h.auditJson).toHaveLength(1);
    expect(h.auditJson[0]).toContain('"addedPackages"');
    expect(h.auditJson[0]).toContain("com.example.dep");
    expect(h.auditJson[0]).toContain('"connectorRequirements"');
    expect(h.auditJson[0]).toContain('"planPermissions"');
    expect(h.auditJson[0]).not.toContain("planText");
    expect(h.auditJson[0]).not.toContain("This update adds");
  });

  test("without planText, the added packages stay in the Details line", async () => {
    const h = capture();
    await h.exec.execute({
      type: "extension.autoUpdate",
      payload: { ...BASE_PAYLOAD, addedPackages: ADDED },
    });
    expect(h.prompts[0]).toContain('"addedPackages"');
  });

  test("a downgrade's planText is not a plan: it stays in the Details line", async () => {
    const h = capture();
    await h.exec.execute({
      type: "extension.downgrade",
      payload: { ...BASE_PAYLOAD, planText: PLAN_TEXT },
    });
    expect(h.prompts[0]).toContain('"planText"');
  });
});

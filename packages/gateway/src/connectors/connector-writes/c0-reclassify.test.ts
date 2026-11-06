// packages/gateway/src/connectors/connector-writes/c0-reclassify.test.ts
//
// Phase 9.7 PR C0 (spec § 15, owner rulings OR-W34-1 and OR-W34-3, 2026-11-06).
import { describe, expect, test } from "bun:test";
import { serviceOf } from "../../engine/service-of.ts";
import { offerableWritesEnabledBy, writesEnabledBy } from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

const SENDS = [
  "apple_mail_send",
  "fastmail_mail_send",
  "gmail_draft_send",
  "gmail_message_send",
  "imap_mail_send",
  "outlook_mail_send",
  "protonmail_mail_send",
] as const;

/** OR-W34-3: low blast radius, so wave 3 (Phase 10 may auto-fire them). */
const DOWN_TO_WAVE_3 = [
  "bigeye_issue_acknowledge",
  "bigeye_issue_resolve",
  "looker_datagroup_trigger",
  "looker_schedule_run_once",
  "montecarlo_incident_acknowledge",
  "montecarlo_incident_resolve",
  "powerbi_dataflow_refresh",
  "powerbi_dataset_refresh",
  "tableau_datasource_refresh",
  "tableau_workbook_refresh",
] as const;

/** OR-W34-3: irreversible, so wave 4 (always prompts; a before-state and type-to-confirm later). */
const UP_TO_WAVE_4 = [
  "apple_calendar_event_delete",
  "bitbucket_pr_merge",
  "github_branch_delete",
  "github_pr_merge",
  "github_tag_create",
  "gitlab_mr_merge",
  "outlook_calendar_delete",
] as const;

/**
 * Each moved-down row's input-schema keys in connectors 0.5.0, spelled out from the connector
 * source (nimbus-mcp-servers bf050b36: `tableau/src/server.ts`, `looker/src/server.ts`,
 * `powerbi/src/server.ts`, `monte-carlo/src/server.ts`, `bigeye/src/server.ts`), so the door's
 * drift check (template keys within the listed schema, spec § 13) passes against the real server.
 */
const SCHEMA_KEYS: Readonly<Record<(typeof DOWN_TO_WAVE_3)[number], readonly string[]>> = {
  bigeye_issue_acknowledge: ["issueId"],
  bigeye_issue_resolve: ["issueId"],
  looker_datagroup_trigger: ["datagroupId"],
  looker_schedule_run_once: ["scheduledPlanId"],
  montecarlo_incident_acknowledge: ["incidentId"],
  montecarlo_incident_resolve: ["incidentId"],
  powerbi_dataflow_refresh: ["dataflowId", "groupId"],
  powerbi_dataset_refresh: ["datasetId", "groupId"],
  tableau_datasource_refresh: ["id"],
  tableau_workbook_refresh: ["id"],
};

describe("C0: the sends are never offered to the model (OR-W34-1)", () => {
  test("the set is exactly the seven sends, each a real row whose action type ends in .send", () => {
    expect([...MODEL_NEVER_OFFERED_TOOL_IDS].sort((a, b) => a.localeCompare(b))).toEqual([
      ...SENDS,
    ]);
    for (const id of SENDS) expect(rowOf(id).actionType.endsWith(".send"), id).toBe(true);
  });

  test("the set is frozen", () => {
    expect(Object.isFrozen(MODEL_NEVER_OFFERED_TOOL_IDS)).toBe(true);
  });

  test("a send with a template, a reader and wave 2 is still not offerable; the same row under another id is", () => {
    const preview = { target: "{to}", summary: "Send mail", fields: [] };
    const before = {
      tool: "x_get",
      argKeys: ["id"],
      args: (input: Readonly<Record<string, unknown>>) => ({ id: input["id"] }),
      select: () => [],
    };
    for (const id of SENDS) {
      const r = rowOf(id);
      expect(isModelOfferableRow({ ...r, wave: 2, preview, before }), id).toBe(false);
      expect(isModelOfferableRow({ ...r, toolId: `${id}_x`, wave: 2, preview, before }), id).toBe(
        true,
      );
    }
  });

  test("no enabled wave offers a send", () => {
    for (const id of SENDS) {
      const service = serviceOf(rowOf(id).actionType);
      for (const wave of [2, 3, 4] as const) {
        expect(
          offerableWritesEnabledBy(service, wave).map((r) => r.toolId),
          `${service} ${wave}`,
        ).not.toContain(id);
      }
    }
  });
});

describe("C0: the reclassification (OR-W34-3)", () => {
  test("the ten low-risk rows are wave 3 and the seven irreversible rows wave 4", () => {
    for (const id of DOWN_TO_WAVE_3) expect(rowOf(id).wave, id).toBe(3);
    for (const id of UP_TO_WAVE_4) expect(rowOf(id).wave, id).toBe(4);
  });

  test("the ten are offerable under the default max_wave 3, and their templates match the 0.5.0 schemas", () => {
    for (const id of DOWN_TO_WAVE_3) {
      const r = rowOf(id);
      expect(
        offerableWritesEnabledBy(serviceOf(r.actionType), 3).map((x) => x.toolId),
        id,
      ).toContain(id);
      if (r.preview === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(r.preview)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...SCHEMA_KEYS[id]]);
    }
  });

  test("the seven are outside a wave-3 opt-in and not offerable (no template yet)", () => {
    for (const id of UP_TO_WAVE_4) {
      const r = rowOf(id);
      const service = serviceOf(r.actionType);
      expect(
        writesEnabledBy(service, 3).map((x) => x.toolId),
        id,
      ).not.toContain(id);
      expect(
        writesEnabledBy(service, 4).map((x) => x.toolId),
        id,
      ).toContain(id);
      expect(isModelOfferableRow(r), id).toBe(false);
    }
  });

  test("the two Snowflake writes stay wave 4, so Wave 4 still has eight templated write-transport rows", () => {
    const templatedWriteW4 = CONNECTOR_WRITE_ROWS.filter(
      (r) => r.transport === "write" && r.wave === 4 && r.preview !== undefined,
    ).map((r) => r.toolId);
    expect(templatedWriteW4.sort((a, b) => a.localeCompare(b))).toEqual([
      "argocd_app_rollback",
      "argocd_app_sync",
      "flux_helmrelease_reconcile",
      "flux_kustomization_reconcile",
      "mlflow_model_promote",
      "mlflow_model_transition_stage",
      "snowflake_comment_set",
      "snowflake_tag_set",
    ]);
  });
});

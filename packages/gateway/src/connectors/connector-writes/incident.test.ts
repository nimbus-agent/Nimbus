import { describe, expect, test } from "bun:test";
import { INCIDENT_ROWS, selectJiraOpsAlert, selectPagerdutyIncident } from "./incident.ts";

function fields(list: readonly { label: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(list.map((f) => [f.label, f.value]));
}

function readerOf(toolId: string) {
  const reader = INCIDENT_ROWS.find((r) => r.toolId === toolId)?.before;
  if (reader === undefined) throw new Error(`no before reader for ${toolId}`);
  return reader;
}

describe("incident before-state readers: input handling", () => {
  test.each([
    ["pd_incident_acknowledge", "incidentId"],
    ["pd_incident_resolve", "incidentId"],
    ["pd_incident_escalate", "incidentId"],
    ["jira_ops_alert_acknowledge", "alertId"],
    ["jira_ops_alert_close", "alertId"],
  ])("%s builds its read from a non-empty string id and refuses anything else", (toolId, key) => {
    const reader = readerOf(toolId);
    expect(reader.args({ [key]: "ID-1" })).toEqual({ [key]: "ID-1" });
    expect(reader.args({ [key]: "" })).toBeUndefined();
    expect(reader.args({ [key]: 7 })).toBeUndefined();
    expect(reader.args({})).toBeUndefined();
  });
});

describe("selectPagerdutyIncident: edges", () => {
  test("a reply that is not an object throws", () => {
    expect(() => selectPagerdutyIncident("nope")).toThrow();
    expect(() => selectPagerdutyIncident(null)).toThrow();
  });

  test("assignments that name nobody read as (nobody); a non-list assignments field is omitted", () => {
    const none = fields(
      selectPagerdutyIncident({ incident: { title: "t", assignments: [{ assignee: {} }] } }),
    );
    expect(none["Assigned to"]).toBe("(nobody)");
    const notList = fields(selectPagerdutyIncident({ incident: { title: "t", assignments: "x" } }));
    expect(Object.hasOwn(notList, "Assigned to")).toBe(false);
  });

  test("the title wins over the summary when both are present", () => {
    expect(
      fields(selectPagerdutyIncident({ incident: { title: "T", summary: "S" } }))["Title"],
    ).toBe("T");
  });
});

describe("selectJiraOpsAlert: edges", () => {
  test("a reply with no message throws, as does one that is not an object", () => {
    expect(() => selectJiraOpsAlert({ status: "open" })).toThrow();
    expect(() => selectJiraOpsAlert(5)).toThrow();
  });

  test("acknowledged true on an open alert shows yes and the acknowledged note", () => {
    const f = fields(selectJiraOpsAlert({ message: "m", status: "open", acknowledged: true }));
    expect(f["Acknowledged"]).toBe("yes");
    expect(f["Note"]).toContain("Already acknowledged");
  });

  test("a non-boolean acknowledged is omitted and gives no note", () => {
    const f = fields(selectJiraOpsAlert({ message: "m", acknowledged: "yes" }));
    expect(Object.hasOwn(f, "Acknowledged")).toBe(false);
    expect(Object.hasOwn(f, "Note")).toBe(false);
  });

  test("closed wins over acknowledged for the note", () => {
    const f = fields(selectJiraOpsAlert({ message: "m", status: "closed", acknowledged: true }));
    expect(f["Note"]).toContain("Already closed");
  });
});

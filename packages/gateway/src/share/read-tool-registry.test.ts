import { describe, expect, test } from "bun:test";
import { WAREHOUSE_BI_WRITE_TOOL_IDS } from "../connectors/warehouse-write-tools.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { isReadOnlyToolId } from "./read-tool-registry.ts";

describe("isReadOnlyToolId — positive read-only allowlist", () => {
  test("the spec's four read-verb suffixes classify read-only", () => {
    expect(isReadOnlyToolId("gmail_list")).toBe(true);
    expect(isReadOnlyToolId("slack_user_get")).toBe(true);
    expect(isReadOnlyToolId("snowflake_table_query")).toBe(true);
    expect(isReadOnlyToolId("slack_search")).toBe(true);
  });

  test("curated read-surface verbs (grounded in real connector tool ids) classify read-only", () => {
    expect(isReadOnlyToolId("slack_channel_history")).toBe(true);
    expect(isReadOnlyToolId("dataprofile_preview")).toBe(true);
    expect(isReadOnlyToolId("drive_file_read")).toBe(true);
  });

  test("write verbs classify NON-read", () => {
    for (const w of ["email_send", "file_delete", "jira_issue_create", "calendar_event_update"]) {
      expect(isReadOnlyToolId(w)).toBe(false);
    }
  });

  test("malformed / empty / no-underscore input is non-read (fail-safe)", () => {
    expect(isReadOnlyToolId("")).toBe(false);
    expect(isReadOnlyToolId("recommend")).toBe(false);
    expect(isReadOnlyToolId("get")).toBe(false); // bare verb, no tool prefix
  });

  // SECURITY-LOAD-BEARING (spec §8.1): classification is POSITIVE, never "absent from HITL".
  test("a write tool ABSENT from HITL_REQUIRED_BACKING is still non-read", () => {
    const fabricatedWrite = "acme_destroy"; // not a read verb, and not in the HITL frozen set
    expect(HITL_REQUIRED.has("acme.destroy")).toBe(false); // genuinely absent from HITL
    expect(isReadOnlyToolId(fabricatedWrite)).toBe(false); // …yet still classified non-read
  });

  test("warehouse/BI write tool ids are all non-read (they end in write verbs)", () => {
    for (const id of WAREHOUSE_BI_WRITE_TOOL_IDS) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
  });
});

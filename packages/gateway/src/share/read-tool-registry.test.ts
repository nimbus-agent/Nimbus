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
    expect(isReadOnlyToolId("drive_file_read")).toBe(true);
    expect(isReadOnlyToolId("gdrive_file_metadata")).toBe(true);
  });

  // SECURITY-LOAD-BEARING: `preview` reads as a read verb and is not one. `iac_pulumi_preview`
  // runs `pulumi preview --cwd <caller-supplied directory>`, and `pulumi preview` EVALUATES the
  // stack program in that directory — so admitting the verb let an untrusted share file reach
  // local code execution through a list named "read-only". It is the ONLY real connector tool id
  // ending in `_preview`, so removing the verb costs no replay coverage.
  test("`preview` is NOT a read verb — it admitted a process-spawning tool", () => {
    expect(isReadOnlyToolId("iac_pulumi_preview")).toBe(false);
  });

  test("no iac tool is classified read-only — every one of them shells out", () => {
    for (const id of [
      "iac_terraform_plan",
      "iac_terraform_apply",
      "iac_terraform_destroy",
      "iac_cloudformation_deploy",
      "iac_pulumi_preview",
      "iac_pulumi_up",
    ]) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
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

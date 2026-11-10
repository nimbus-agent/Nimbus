import { describe, expect, test } from "bun:test";
import { CONNECTOR_WRITES } from "../connectors/connector-write-registry.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
} from "../connectors/testing/connector-write-registrations.ts";
import { HITL_REQUIRED } from "../engine/executor.ts";
import { serviceOf } from "../engine/service-of.ts";
import { EXTRA_READ_TOOL_IDS, isReadOnlyToolId } from "./read-tool-registry.ts";

describe("isReadOnlyToolId — connector write ids", () => {
  // Regression guard, not a failing-capable test: no real write id ends in a read verb today.
  test("every connector write row id is refused, bare and namespaced", () => {
    for (const r of CONNECTOR_WRITE_ROWS) {
      expect(isReadOnlyToolId(r.toolId), r.toolId).toBe(false);
      expect(isReadOnlyToolId(`${serviceOf(r.actionType)}__${r.toolId}`), r.toolId).toBe(false);
    }
  });

  // The one that can fail: a synthetic write id ending in a read verb is refused only by the new
  // write-id check (its trailing `_export` would otherwise classify it read-only).
  test("a write id that ends in a read verb is refused, bare and as <server>__<tool>", () => {
    const writeIds = new Set(["fx_report_export"]);
    expect(isReadOnlyToolId("fx_report_export")).toBe(true);
    expect(isReadOnlyToolId("fx_report_export", writeIds)).toBe(false);
    expect(isReadOnlyToolId("fx__fx_report_export", writeIds)).toBe(false);
    expect(isReadOnlyToolId("fx_fx_report_export", writeIds)).toBe(false);
    expect(isReadOnlyToolId("fx_report_list", writeIds)).toBe(true);
  });
});

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

  // connectors 0.5.0 added `obsidian_daily_note_get` as a READ (registered with `reg`, no HITL);
  // the append it reads for stays a write row.
  test("connectors 0.5.0: the Obsidian daily-note read is read-only and not a write row", () => {
    expect(isReadOnlyToolId("obsidian_daily_note_get")).toBe(true);
    expect(isReadOnlyToolId("obsidian__obsidian_daily_note_get")).toBe(true);
    const ids = CONNECTOR_WRITE_ROWS.map((r) => r.toolId);
    expect(ids).not.toContain("obsidian_daily_note_get");
    expect(ids).toContain("obsidian_append_to_daily_note");
    expect(isReadOnlyToolId("obsidian_append_to_daily_note")).toBe(false);
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

  // SECURITY-LOAD-BEARING: these end in genuine read verbs (`list`/`get`/`search`) that hundreds of
  // real reads carry, so the verb cannot be dropped the way `preview` was. They reach an `az` /
  // `gcloud` `.cmd` wrapper's argv on Windows, where a share-supplied value injects a command, so
  // they are excluded by explicit id (I26 `isConnectorCodeExecutionToolId`) — closing the share
  // door, as the federated gate closes its own.
  test("az/gcloud code-execution reads are NON-read despite ending in a read verb", () => {
    for (const id of [
      "azure_app_service_list",
      "gcp_cloud_run_service_list",
      "cloud_logging_get",
      "cloud_logging_search",
      "vertex_ai_get",
      "vertex_ai_list",
      // and the `<server>_<tool>` session form, which a forwarded recipe can also name
      "azure_azure_app_service_list",
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

  test("dispatchable connector write tool ids are all non-read (they end in write verbs)", () => {
    for (const id of CONNECTOR_WRITES.map((w) => w.toolId)) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
  });
});

// I42: a user-registered MCP server's tools are owner-approved per call. A share file is a door a
// third party names tools through, so a user-MCP key is never replayable whatever verb it ends in.
describe("isReadOnlyToolId — user-MCP tool keys (I42)", () => {
  test("a user-MCP key ending in a read verb is NOT read-only", () => {
    expect(isReadOnlyToolId("mcp_notes_search")).toBe(false);
    expect(isReadOnlyToolId("mcp_x_get")).toBe(false);
    expect(isReadOnlyToolId("mcp_a_b_list")).toBe(false);
  });

  test("a first-party key with the same verb is unaffected", () => {
    expect(isReadOnlyToolId("notes_search")).toBe(true);
  });
});

// Connectors 0.10.0 added two reads that end in `_latest`, a suffix `READ_VERBS` deliberately does
// not carry (a verb earns a place only when every tool that can carry it is a read). They are
// named by id instead, bare and namespaced.
describe("isReadOnlyToolId — EXTRA_READ_TOOL_IDS (the two `_latest` reads)", () => {
  test("exactly the two build-latest reads, bare and namespaced", () => {
    expect([...EXTRA_READ_TOOL_IDS].sort()).toEqual([
      "bitrise_build_latest",
      "codemagic_build_latest",
    ]);
    for (const id of ["bitrise_build_latest", "codemagic_build_latest"]) {
      expect(isReadOnlyToolId(id), id).toBe(true);
      expect(isReadOnlyToolId(`${id.split("_")[0]}_${id}`), id).toBe(true);
    }
  });

  test("a different `_latest` tool is still not a read, and no verb was added", () => {
    expect(isReadOnlyToolId("bitrise_build_latest_extra")).toBe(false);
    expect(isReadOnlyToolId("acme_build_latest")).toBe(false);
    expect(isReadOnlyToolId("acme_deploy_latest")).toBe(false);
  });

  test("a connector write id is never a read, even named like an extra read", () => {
    expect(isReadOnlyToolId("bitrise_build_latest", new Set(["bitrise_build_latest"]))).toBe(false);
  });

  test("a user-MCP key ending in an extra read id is still refused (I42)", () => {
    expect(isReadOnlyToolId("mcp_x_bitrise_build_latest")).toBe(false);
  });

  // The installed package decides: any registered tool ending in `_latest` outside the list fails
  // here until someone decides what it is.
  test("the installed connectors register no other `_latest` tool", () => {
    const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
    expect(sources.length).toBeGreaterThan(100);
    const found = new Set<string>();
    for (const s of sources) {
      for (const m of s.text.matchAll(/["'`]([a-z0-9_]+_latest)["'`]/g)) found.add(m[1] ?? "");
    }
    expect([...found].sort()).toEqual([...EXTRA_READ_TOOL_IDS].sort());
  });
});

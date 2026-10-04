import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CODE_EXECUTION_TOOL_IDS,
  isConnectorCodeExecutionToolId,
} from "./connector-code-execution-tool-ids.ts";
import { isConnectorWriteToolId } from "./connector-write-registry.ts";

describe("isConnectorCodeExecutionToolId (I26)", () => {
  test("names the two reads that evaluate a caller-named directory, bare and namespaced", () => {
    for (const id of [
      "iac_terraform_plan",
      "iac_pulumi_preview",
      // The key a team-credentialed session executes: `@mastra/mcp` prefixes the server.
      "iac_iac_terraform_plan",
      "iac_iac_pulumi_preview",
      // Any server key, at any depth — the phase-3 bundle is one session over many servers.
      "some_bundle_iac_iac_pulumi_preview",
    ]) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
    }
  });

  test("names the iac writes that evaluate it too, independently of the write predicate", () => {
    for (const id of ["iac_terraform_apply", "iac_terraform_destroy", "iac_pulumi_up"]) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`iac_${id}`), id).toBe(true);
      expect(isConnectorWriteToolId(id), id).toBe(true); // and refused as a write, which runs first
    }
  });

  test("over-blocks nothing: other tools of process-spawning connectors are not code execution", () => {
    for (const id of [
      "iac_cloudformation_deploy", // remote deploy, refused as a write instead
      "iac_iac_cloudformation_deploy",
      "aws_aws_ecs_service_list",
      "kubernetes_k8s_pod_list",
      "athena_athena_get",
      "gcp_gcp_cloud_run_service_list",
      "vertex_ai_vertex_ai_get",
    ]) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(false);
    }
  });

  test("only a `_`-delimited SUFFIX names one — not a lookalike, not a prefix", () => {
    for (const id of [
      "xiac_terraform_plan",
      "iac_terraform_plan_status",
      "iac_terraform_planx",
      "iac_terraform",
      "terraform_plan",
      "",
      "_",
    ]) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(false);
    }
  });

  test("its cost is bounded by the longest listed id, not by the caller's id", () => {
    const hostile = "_".repeat(200_000);
    const started = performance.now();
    expect(isConnectorCodeExecutionToolId(hostile)).toBe(false);
    expect(isConnectorCodeExecutionToolId(`${hostile}iac_pulumi_preview`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the list holds tool ids, in the shape a connector registers them", () => {
    expect(CONNECTOR_CODE_EXECUTION_TOOL_IDS.size).toBeGreaterThanOrEqual(2);
    for (const id of CONNECTOR_CODE_EXECUTION_TOOL_IDS) {
      expect(id, id).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/);
    }
  });
});

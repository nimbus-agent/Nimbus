import { describe, expect, test } from "bun:test";
import {
  CONNECTOR_CODE_EXECUTION_TOOL_IDS,
  DIRECTORY_EVALUATION_TOOL_IDS,
  isConnectorCodeExecutionToolId,
  WINDOWS_CLI_ARG_INJECTION_TOOL_IDS,
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

  test("names every az/gcloud-backed read that can carry a caller value, bare and namespaced", () => {
    // On Windows `az` / `gcloud` resolve to `.cmd` wrappers that re-parse argv, so a caller value
    // reaching them escapes its slot — refused at the federated door, bare and in the session form.
    for (const id of [
      "azure_app_service_list",
      "gcp_cloud_run_service_list",
      "cloud_logging_get",
      "cloud_logging_list",
      "cloud_logging_search",
      "vertex_ai_get",
      "vertex_ai_list",
      "vertex_ai_search",
    ]) {
      expect(WINDOWS_CLI_ARG_INJECTION_TOOL_IDS.has(id), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`azure_${id}`), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`team_bundle_gcp_${id}`), id).toBe(true);
    }
  });

  test("the union is exactly the two documented subsets, and they are disjoint", () => {
    expect(new Set(CONNECTOR_CODE_EXECUTION_TOOL_IDS)).toEqual(
      new Set([...DIRECTORY_EVALUATION_TOOL_IDS, ...WINDOWS_CLI_ARG_INJECTION_TOOL_IDS]),
    );
    for (const id of DIRECTORY_EVALUATION_TOOL_IDS) {
      expect(WINDOWS_CLI_ARG_INJECTION_TOOL_IDS.has(id), id).toBe(false);
    }
  });

  test("over-blocks nothing: other tools of process-spawning connectors are not code execution", () => {
    for (const id of [
      "iac_cloudformation_deploy", // remote deploy, refused as a write instead
      "iac_iac_cloudformation_deploy",
      "aws_aws_ecs_service_list", // aws → native .exe on Windows, no cmd re-parse
      "kubernetes_k8s_pod_list", // kubectl → native .exe
      "athena_athena_get", // aws
      "cloudwatch_cloudwatch_list", // aws
      "sagemaker_sagemaker_get", // aws
      "bigquery_bigquery_get", // REST; its only spawn takes no caller input
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

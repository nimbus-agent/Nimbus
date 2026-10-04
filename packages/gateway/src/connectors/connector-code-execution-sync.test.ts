/**
 * I26 sync guard for the code-execution half: every tool a federated peer could use to run
 * caller-directed code on the trust anchor is refused at the invoke gate.
 *
 * `CONNECTOR_CODE_EXECUTION_TOOL_IDS` is a hand-maintained list, and nothing upstream marks a tool
 * as running code: `iac_terraform_plan` and `iac_pulumi_preview` are plain READ registrations that
 * evaluate the directory a caller names. So this checks the list against the INSTALLED connectors
 * package in both directions. Every listed id must still be registered there (a rename cannot leave
 * the list naming nothing). And every connector that can start a process or evaluate code at all —
 * derived from its source, see `./testing/connector-process-spawns.ts` — must appear in the review
 * below, with each tool it registers refused as code execution, refused as a write, or reviewed as
 * a read whose caller-supplied values cannot select code. A connector that newly gains the
 * capability, or a new tool in one that has it, fails here until someone decides.
 *
 * Stated bound: a tool of a connector WITHOUT the capability cannot start a process from its own
 * code, so it is not reviewed here; a third-party package that spawns internally, and a capability
 * reached by reflection, are outside the scan (see the helper's module comment).
 */
import { describe, expect, test } from "bun:test";
import { isReadOnlyToolId } from "../share/read-tool-registry.ts";
import {
  CONNECTOR_CODE_EXECUTION_TOOL_IDS,
  isConnectorCodeExecutionToolId,
} from "./connector-code-execution-tool-ids.ts";
import { isConnectorWriteToolId } from "./connector-write-registry.ts";
import { scanProcessSpawningConnectors } from "./testing/connector-process-spawns.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
} from "./testing/connector-write-registrations.ts";

const SCAN = scanProcessSpawningConnectors(
  readConnectorPackageSources(installedConnectorsPackageRoot()),
);

/**
 * The review: every connector whose source can start a process, and each of its READ tools that
 * does so without letting the caller pick what runs. Writes are not listed: I26 refuses them all.
 * Reviewed 2026-10-05 against @nimbus-dev/connectors 0.2.1 and 0.2.2, identical for these eleven.
 */
const REVIEWED_PROCESS_CONNECTORS: Readonly<
  Record<string, { readonly reads: readonly string[]; readonly why: string }>
> = {
  athena: {
    reads: ["athena_get", "athena_list", "athena_search"],
    why: "fixed `aws athena` list/get calls; every caller value is an isSafeCliArg-guarded flag value",
  },
  aws: {
    reads: ["aws_ecs_service_list", "aws_lambda_list"],
    why: "fixed `aws` subcommands; the one caller value (`--cluster`) is a flag value",
  },
  azure: {
    reads: ["azure_app_service_list"],
    why: "fixed `az webapp list`; the caller values are flag values",
  },
  bigquery: {
    reads: ["bigquery_get", "bigquery_list", "bigquery_search"],
    why: "its only spawn is `gcloud auth print-access-token`, with no caller input; tools are REST",
  },
  "cloud-logging": {
    reads: ["cloud_logging_get", "cloud_logging_list", "cloud_logging_search"],
    why: "fixed `gcloud logging sinks` calls; the one positional (the sink) is isSafeCliArg-guarded",
  },
  cloudwatch: {
    reads: ["cloudwatch_get", "cloudwatch_list", "cloudwatch_search"],
    why: "fixed `aws logs` calls; every caller value is an isSafeCliArg-guarded flag value",
  },
  gcp: {
    reads: ["gcp_cloud_run_service_list"],
    why: "fixed `gcloud run services list`; caller values sit inside `--flag=value` tokens",
  },
  iac: {
    reads: [],
    why: "every tool hands terraform or pulumi a caller-named directory, which evaluates its code",
  },
  kubernetes: {
    reads: ["k8s_deployment_list", "k8s_event_list", "k8s_pod_list"],
    why: "fixed `kubectl get <resource>`; the one caller value is the `-n` flag's value",
  },
  sagemaker: {
    reads: ["sagemaker_get", "sagemaker_list", "sagemaker_search"],
    why: "fixed `aws sagemaker` calls; every caller value is an isSafeCliArg-guarded flag value",
  },
  "vertex-ai": {
    reads: ["vertex_ai_get", "vertex_ai_list", "vertex_ai_search"],
    why: "fixed `gcloud ai models` calls; the model positional and the region are isSafeCliArg-guarded",
  },
};

/** The key a session lists a connector's tools under: its directory, `-` → `_`. */
function serverKey(connector: string): string {
  return connector.replaceAll("-", "_");
}

/** How the federated invoke gate treats a tool of a process-capable connector. */
function verdict(connector: string, toolId: string): string {
  if (isConnectorCodeExecutionToolId(toolId)) return "refused: code execution";
  if (isConnectorWriteToolId(toolId)) return "refused: write";
  return REVIEWED_PROCESS_CONNECTORS[connector]?.reads.includes(toolId) === true
    ? "reviewed read"
    : "UNCLASSIFIED";
}

describe("I26 code-execution sync guard — the installed connectors package", () => {
  test("the scan followed every import and registration it found", () => {
    expect(SCAN.violations.map((v) => `${v.file}:${String(v.line)} ${v.reason}`)).toEqual([]);
  });

  test("every listed code-executing tool is still registered by a connector that can spawn", () => {
    // A renamed tool would leave the list naming nothing while the new name ran unrefused.
    const registered = new Set(SCAN.connectors.flatMap((c) => c.toolIds));
    expect([...CONNECTOR_CODE_EXECUTION_TOOL_IDS].filter((id) => !registered.has(id))).toEqual([]);
  });

  test("every connector that can start a process has been reviewed — and no reviewed one has stopped", () => {
    expect(
      SCAN.connectors.map((c) => c.id),
      "a connector can now start a process: review whether any of its tools lets the caller pick " +
        "what runs, and add it to REVIEWED_PROCESS_CONNECTORS (or the code-execution list)",
    ).toEqual(Object.keys(REVIEWED_PROCESS_CONNECTORS).sort((a, b) => a.localeCompare(b)));
  });

  test("every tool of such a connector is refused at the federated gate or reviewed", () => {
    const unclassified = SCAN.connectors.flatMap((c) =>
      c.toolIds.filter((t) => verdict(c.id, t) === "UNCLASSIFIED").map((t) => `${c.id}: ${t}`),
    );
    expect(
      unclassified,
      "a tool of a process-capable connector is neither refused nor reviewed — decide whether the " +
        "caller can pick what it runs (CONNECTOR_CODE_EXECUTION_TOOL_IDS) or review it as a read",
    ).toEqual([]);
  });

  test("and the same verdict holds in the `<server>_<tool>` form a federated session executes", () => {
    const drifted = SCAN.connectors.flatMap((c) =>
      c.toolIds
        .filter(
          (t) =>
            isConnectorCodeExecutionToolId(`${serverKey(c.id)}_${t}`) !==
            isConnectorCodeExecutionToolId(t),
        )
        .map((t) => `${serverKey(c.id)}_${t}`),
    );
    expect(drifted).toEqual([]);
  });

  test("each reviewed read still exists, and is neither code execution nor a write", () => {
    const stale: string[] = [];
    for (const [id, review] of Object.entries(REVIEWED_PROCESS_CONNECTORS)) {
      if (review.why.trim() === "") stale.push(`${id}: reviewed without a reason`);
      const tools = SCAN.connectors.find((c) => c.id === id)?.toolIds ?? [];
      for (const read of review.reads) {
        if (!tools.includes(read)) stale.push(`${id}: ${read} is no longer registered`);
        if (isConnectorCodeExecutionToolId(read) || isConnectorWriteToolId(read)) {
          stale.push(`${id}: ${read} is reviewed as a read but refused as well`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  test("no code-executing tool is read-only to share replay, the other door a caller names tools through", () => {
    // `share.replay` runs the tool ids an untrusted share file names, gated by a NAME-based read
    // classifier that dropped `preview` for exactly this reason.
    expect([...CONNECTOR_CODE_EXECUTION_TOOL_IDS].filter((id) => isReadOnlyToolId(id))).toEqual([]);
  });
});

describe("I26 code-execution sync guard — guarding the guard", () => {
  test("it derived a plausible census, each connector's tools exactly once", () => {
    // 0.2.1 and 0.2.2 both have eleven process-capable connectors registering 42 tools; an empty or
    // collapsing derivation would pass every check above forever.
    expect(SCAN.connectors.length).toBeGreaterThanOrEqual(11);
    const tools = SCAN.connectors.flatMap((c) => c.toolIds);
    expect(tools.length).toBeGreaterThanOrEqual(42);
    expect(new Set(tools).size).toBe(tools.length);
  });

  test("the iac connector is in it, and its two code-executing reads with it", () => {
    // The finding this guard exists for: if the scan stopped seeing iac, the review would be moot.
    const iac = SCAN.connectors.find((c) => c.id === "iac");
    expect(iac?.toolIds).toEqual(
      expect.arrayContaining(["iac_terraform_plan", "iac_pulumi_preview"]),
    );
  });

  test("every listed id is refused bare and namespaced, at any depth", () => {
    for (const id of CONNECTOR_CODE_EXECUTION_TOOL_IDS) {
      expect(isConnectorCodeExecutionToolId(id), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`iac_${id}`), id).toBe(true);
      expect(isConnectorCodeExecutionToolId(`team_bundle_iac_${id}`), id).toBe(true);
    }
  });
});

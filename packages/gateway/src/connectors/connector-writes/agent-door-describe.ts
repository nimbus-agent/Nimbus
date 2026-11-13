// packages/gateway/src/connectors/connector-writes/agent-door-describe.ts
// What the agent door shows an approved outside agent about ONE write (Phase 28 AD3a-2b, D-4): the
// model door's own description and the model door's own input schema, with the fields the gateway
// binds taken out. Pure: it reads nothing, lists nothing and never sees a hash, an approval or a
// credential, so there is nothing of those to leak. `agent-door-runtime.ts` calls it only for a tool
// whose definition passed the same check a submit runs.
//
//   description  `describeFor`, exactly as the model door builds it: a bound row's text is the
//                gateway's own (the connector's text names the field the gateway binds), a non-bound
//                row's connector text is closer-escaped inside `<tool_description>` behind a fixed
//                first-party lead and capped at 1000 characters in all. The Terraform row names the
//                approved directories and a Kubernetes row the approved (context, namespace) pairs
//                (OR-AD-16), never a server address.
//   inputSchema  `offeredInputJsonSchema`: the listed schema read back verbatim, the row's bound
//                fields (`expectedHeadSha`, `planFile`, `planSha256`, `changeSetId`, `diffSha256`)
//                removed from `properties` and `required`, then the structural allowlist rebuild.
import { describeFor, type K8sPair } from "../../engine/connector-write-agent-tools.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { offeredInputJsonSchema } from "../../engine/user-mcp-agent-tools.ts";
import type { ConnectorWriteRow } from "./types.ts";

/** The approved scope a Terraform or Kubernetes row's description names (OR-AD-16). */
export interface DescribeScope {
  readonly workdirs: readonly string[];
  readonly k8sPairs: readonly K8sPair[];
}

/** One write as an approved agent sees it. */
export interface DescribedWrite {
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function listedDescriptionOf(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return "";
  const text = (entry as Record<string, unknown>)["description"];
  return typeof text === "string" ? text : "";
}

/** `entry` is the listing's own entry for the row's tool (`listed[mcpClientToolKey(service, toolId)]`). */
export function describeApprovedWrite(
  row: ConnectorWriteRow,
  entry: unknown,
  scope: DescribeScope,
): DescribedWrite {
  const entrySchema =
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>)["inputSchema"]
      : undefined;
  return {
    description: describeFor(
      row,
      serviceOf(row.actionType),
      listedDescriptionOf(entry),
      scope.workdirs,
      scope.k8sPairs,
    ),
    inputSchema: offeredInputJsonSchema(
      entrySchema,
      row.bound === undefined ? [] : row.bound.binds.map((b) => b.field),
    ),
  };
}

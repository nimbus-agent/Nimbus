// packages/gateway/src/connectors/connector-writes/cloud-readers.ts
// The before-state readers of the Wave 4 cloud writes that have one (Phase 9.7 D1, group B): the
// Lambda invoke, the EC2 stop and start and the ECS service update, all AWS (native `aws` CLI). The
// reply shapes are the connector's own projections (`aws_ec2_instance_get`, `aws_ecs_service_get`)
// or the CLI's JSON (`aws lambda list-functions`). The Azure and Cloud Run rows have no reader (see
// `cloud-infra.ts`). Imported BY `cloud-infra.ts`, so it imports nothing from the row table.
import {
  arrayAt,
  type BeforeInput,
  type BeforePicked,
  beforeReplyJson,
  excerptHead,
  listAt,
  nonEmptyString,
  presentFields,
  requiredStringAt,
  shownHead,
  stringAt,
} from "./before-select.ts";
import type { BeforeStateField } from "./types.ts";

/** The entry of the list reply at `path` whose string at `key` equals `want`, else `undefined`. */
function entryNamed(
  j: unknown,
  path: readonly string[],
  key: readonly string[],
  want: unknown,
): unknown {
  let list: readonly unknown[] | undefined;
  if (path.length > 0) list = arrayAt(j, path);
  else if (Array.isArray(j)) list = j as unknown[];
  if (list === undefined) throw new Error(`before reply: no ${path.join(".") || "list"}`);
  if (typeof want !== "string") return undefined;
  return list.find((e) => stringAt(e, key) === want);
}

/**
 * `aws_lambda_list` input: the list takes no input; the function name is validated here so a write
 * without one reads nothing (the entry is picked out of the reply by name).
 */
export function lambdaListReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  return nonEmptyString(input["functionName"]) === undefined ? undefined : {};
}

/**
 * AWS `aws_lambda_list` (before-state) for an invoke: the function's configuration. A function that
 * is not in the (first-page) list throws, so the write is refused.
 */
export function selectLambdaFunction(
  reply: unknown,
  picked: BeforePicked,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const fn = entryNamed(j, ["Functions"], ["FunctionName"], picked["functionName"]);
  if (fn === undefined) throw new Error("before reply: function not in the list");
  const memory = stringAt(fn, ["MemorySize"]);
  const timeout = stringAt(fn, ["Timeout"]);
  return [
    { label: "Function", value: excerptHead(requiredStringAt(fn, ["FunctionName"])) },
    ...presentFields([
      ["Runtime", shownHead(stringAt(fn, ["Runtime"]))],
      ["Handler", shownHead(stringAt(fn, ["Handler"]))],
      ["Memory", memory === undefined ? undefined : `${memory} MB`],
      ["Timeout", timeout === undefined ? undefined : `${timeout} s`],
      ["Last modified", shownHead(stringAt(fn, ["LastModified"]))],
      ["Description", shownHead(stringAt(fn, ["Description"]))],
    ]),
  ];
}

/** `aws_ec2_instance_get` input: the write's single `instanceIds` string as the read's `instanceId`. */
export function ec2InstanceReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  const instanceId = nonEmptyString(input["instanceIds"]);
  return instanceId === undefined ? undefined : { instanceId };
}

/** The instance's tags as `key=value`, capped by `listAt`; `(none)` for no tags. */
function instanceTags(j: unknown): string | undefined {
  const tags = arrayAt(j, ["tags"]);
  if (tags === undefined) return undefined;
  const pairs = tags.flatMap((t) => {
    const key = stringAt(t, ["key"]);
    return key === undefined ? [] : [`${key}=${stringAt(t, ["value"]) ?? ""}`];
  });
  return listAt({ pairs }, ["pairs"]);
}

/**
 * AWS `aws_ec2_instance_get` (before-state) for a stop or a start: the state (an instance already in
 * the requested state says so), type, launch time, tags and instance profile.
 */
export function selectEc2Instance(
  action: "stop" | "start",
): (reply: unknown) => readonly BeforeStateField[] {
  const already = action === "stop" ? "stopped" : "running";
  return (reply) => {
    const j = beforeReplyJson(reply);
    const id = requiredStringAt(j, ["instanceId"]);
    const state = stringAt(j, ["state"]);
    const doing = action === "stop" ? "stopping" : "starting";
    const shownState =
      state === already ? `${state}: it is already ${already}, so ${doing} it does nothing` : state;
    return [
      { label: "Instance", value: excerptHead(id) },
      ...presentFields([
        ["State", shownHead(shownState)],
        ["Type", shownHead(stringAt(j, ["instanceType"]))],
        ["Launched", shownHead(stringAt(j, ["launchTime"]))],
        ["Tags", shownHead(instanceTags(j))],
        ["IAM profile", shownHead(stringAt(j, ["iamProfileArn"]))],
      ]),
    ];
  };
}

/** `aws_ecs_service_get` input: the cluster and the service. */
export function ecsServiceReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  const cluster = nonEmptyString(input["cluster"]);
  const service = nonEmptyString(input["service"]);
  return cluster === undefined || service === undefined ? undefined : { cluster, service };
}

/** AWS `aws_ecs_service_get` (before-state) for an update: the service as it runs now, beside the new task definition. */
export function selectEcsService(
  reply: unknown,
  picked: BeforePicked,
): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = requiredStringAt(j, ["serviceName"]);
  const next = picked["taskDefinition"];
  const now = stringAt(j, ["taskDefinition"]);
  let task: string | undefined;
  if (now !== undefined) {
    task = typeof next === "string" ? `${now} -> ${next}` : now;
  }
  return [
    { label: "Service", value: excerptHead(name) },
    ...presentFields([
      ["Status", shownHead(stringAt(j, ["status"]))],
      ["Desired count", stringAt(j, ["desiredCount"])],
      ["Running count", stringAt(j, ["runningCount"])],
      ["Task definition", shownHead(task)],
      ["Launch type", shownHead(stringAt(j, ["launchType"]))],
    ]),
  ];
}

// ---- Kubernetes (D3a, D3c): the deployment a restart or a scale will touch ----------------------

/** The resource types a restart's reader applies to (the reader reads a DEPLOYMENT). */
const DEPLOYMENT_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "deployment",
  "deployments",
  "deploy",
]);

/** Whether `resourceType` names a deployment (so `k8s_deployment_get` can show the target). */
export function isDeploymentResourceType(resourceType: unknown): boolean {
  return typeof resourceType === "string" && DEPLOYMENT_RESOURCE_TYPES.has(resourceType);
}

function k8sGetArgs(context: unknown, namespace: unknown, name: unknown) {
  const ctx = nonEmptyString(context);
  const ns = nonEmptyString(namespace);
  const n = nonEmptyString(name);
  return ctx === undefined || ns === undefined || n === undefined
    ? undefined
    : { context: ctx, namespace: ns, name: n };
}

/**
 * `k8s_deployment_get` input for a restart: the write's context, namespace and name, and ONLY when
 * the resource type is a deployment. Any other type reads nothing, so the write has no before-state
 * and a Wave 4 write without one is refused on every door.
 */
export function k8sRestartReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  if (!isDeploymentResourceType(input["resourceType"])) return undefined;
  return k8sGetArgs(input["context"], input["namespace"], input["name"]);
}

/** `k8s_deployment_get` input for a scale: the write's context, namespace and `deploymentName`. */
export function k8sScaleReadArgs(input: BeforeInput): Record<string, unknown> | undefined {
  return k8sGetArgs(input["context"], input["namespace"], input["deploymentName"]);
}

/**
 * `k8s_deployment_get` (before-state), the connector's projection `{name, namespace, replicas,
 * readyReplicas, generation, observedGeneration, restartedAt, images}`. The reply must name the
 * deployment the write names, in the namespace the write names (else it throws and the write is
 * refused: the reader never shows another object's state as this one's). A scale shows the replica
 * change; a restart shows the last restart and the images.
 */
export function selectK8sDeployment(
  kind: "restart" | "scale",
  nameKey: "name" | "deploymentName",
): (reply: unknown, picked: BeforePicked) => readonly BeforeStateField[] {
  return (reply, picked) => {
    const j = beforeReplyJson(reply);
    const name = requiredStringAt(j, ["name"]);
    const namespace = requiredStringAt(j, ["namespace"]);
    if (name !== picked[nameKey] || namespace !== picked["namespace"]) {
      throw new Error("before reply: not the deployment the write names");
    }
    const replicas = stringAt(j, ["replicas"]);
    const next = picked["replicas"];
    const change =
      kind === "scale" && replicas !== undefined && typeof next === "number"
        ? `${replicas} -> ${String(next)}`
        : replicas;
    return [
      { label: "Deployment", value: excerptHead(name) },
      { label: "Namespace", value: excerptHead(namespace) },
      ...presentFields([
        [kind === "scale" ? "Replicas (now -> new)" : "Replicas", change],
        ["Ready replicas", stringAt(j, ["readyReplicas"])],
        ["Last restarted", shownHead(stringAt(j, ["restartedAt"]))],
        ["Images", shownHead(listAt(j, ["images"]))],
      ]),
    ];
  };
}

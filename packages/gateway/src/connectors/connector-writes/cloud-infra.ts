// packages/gateway/src/connectors/connector-writes/cloud-infra.ts

import {
  ec2InstanceReadArgs,
  ecsServiceReadArgs,
  k8sRestartReadArgs,
  k8sScaleReadArgs,
  lambdaListReadArgs,
  selectEc2Instance,
  selectEcsService,
  selectK8sDeployment,
  selectLambdaFunction,
} from "./cloud-readers.ts";
import { CFN_DEPLOY_BOUND, TERRAFORM_APPLY_BOUND, TERRAFORM_DESTROY_BOUND } from "./iac-bound.ts";
import { K8S_APPLY_BOUND } from "./k8s-bound.ts";
import {
  type ConnectorWritePreviewTemplate,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withBound,
  withConfirm,
  withPreview,
  withRefusal,
} from "./types.ts";

/** A wave 4 mesh row with a typed preview and a confirm text (the common shape of this table). */
function meshConfirmRow(
  toolId: string,
  actionType: string,
  preview: ConnectorWritePreviewTemplate,
  template: string,
): ConnectorWriteRow {
  return withConfirm(withPreview(row(toolId, actionType, "mesh", 4), preview), { template });
}

/** The EC2 stop and start differ only in their words and in which state is "already". */
function ec2Row(toolId: string, actionType: string, action: "stop" | "start"): ConnectorWriteRow {
  const verb = action === "stop" ? "Stop" : "Start";
  return withConfirm(
    withBefore(
      withPreview(row(toolId, actionType, "mesh", 4), {
        target: "{instanceIds}",
        summary: `${verb} EC2 instance {instanceIds}`,
        fields: [textField("instanceIds", "Instance id")],
      }),
      {
        tool: "aws_ec2_instance_get",
        argKeys: ["instanceIds"],
        args: ec2InstanceReadArgs,
        select: selectEc2Instance(action),
      },
    ),
    { template: `${action} {instanceIds}` },
  );
}

export const CLOUD_INFRA_ROWS: readonly ConnectorWriteRow[] = [
  // D1 (round-1 fix 9): the connectors release gives the ECS update a real read
  // (`aws_ecs_service_get`). The task definition is shown beside the one the service runs now.
  withConfirm(
    withBefore(
      withPreview(row("aws_ecs_service_update", "aws.ecs.service.update", "mesh", 4), {
        target: "{cluster}/{service}",
        summary:
          "Update ECS service {service} in cluster {cluster} to task definition {taskDefinition} and force a new deployment",
        fields: [
          textField("cluster"),
          textField("service"),
          textField("taskDefinition", "New task definition"),
        ],
      }),
      {
        tool: "aws_ecs_service_get",
        argKeys: ["cluster", "service", "taskDefinition"],
        args: ecsServiceReadArgs,
        select: selectEcsService,
      },
    ),
    { template: "update {cluster}/{service}" },
  ),
  // The Lambda's own code decides what an invoke does; `payloadJson` is shown in full and not
  // scanned. The read lists the first page of functions and picks this one.
  withConfirm(
    withBefore(
      withPreview(row("aws_lambda_invoke", "aws.lambda.invoke", "mesh", 4), {
        target: "{functionName}",
        summary:
          "Invoke AWS Lambda function {functionName}; the function's own code decides what that does",
        fields: [
          textField("functionName", "Function"),
          textField("payloadJson", "Payload (JSON, sent as is)", "(not set: no payload)"),
        ],
      }),
      {
        tool: "aws_lambda_list",
        argKeys: ["functionName"],
        args: lambdaListReadArgs,
        select: selectLambdaFunction,
      },
    ),
    { template: "invoke {functionName}" },
  ),
  ec2Row("aws_ec2_instance_stop", "aws.ec2.instance.stop", "stop"),
  ec2Row("aws_ec2_instance_start", "aws.ec2.instance.start", "start"),
  // The Azure and Cloud Run rows below have a preview and a confirm text but NO before reader, so
  // they are not offered to the model: their natural reads (`azure_app_service_list`,
  // `azure_aks_node_pool_get`, `gcp_cloud_run_service_list`) are `az` / `gcloud` reads, which the
  // code-execution class excludes from `isReadOnlyToolId` (a model-supplied value would reach a
  // `.cmd` wrapper's argv on Windows BEFORE the owner approves), so the before-read dispatcher
  // refuses them. Widening that is a security decision left to the owner (see the D1 report).
  meshConfirmRow(
    "azure_app_service_restart",
    "azure.app_service.restart",
    {
      target: "{resourceGroup}/{name}",
      summary: "Restart Azure App Service {name} in resource group {resourceGroup}",
      fields: [
        textField("subscriptionId", "Subscription"),
        textField("resourceGroup", "Resource group"),
        textField("name", "App Service"),
      ],
    },
    "restart {resourceGroup}/{name}",
  ),
  meshConfirmRow(
    "azure_aks_node_pool_scale",
    "azure.aks.node_pool.scale",
    {
      target: "{resourceGroup}/{clusterName}/{poolName}",
      summary: "Scale AKS node pool {poolName} of cluster {clusterName} to {nodeCount} nodes",
      fields: [
        textField("subscriptionId", "Subscription"),
        textField("resourceGroup", "Resource group"),
        textField("clusterName", "Cluster"),
        textField("poolName", "Node pool"),
        textField("nodeCount", "New node count"),
      ],
    },
    "scale {resourceGroup}/{clusterName}/{poolName} to {nodeCount}",
  ),
  // The confirm text names the image (its last 8 characters, so a long digest stays typeable): the
  // deploy's blast is the image, which the old text did not name (D1 § 2.7).
  meshConfirmRow(
    "gcp_cloud_run_deploy",
    "gcp.cloud_run.deploy",
    {
      target: "{projectId}/{region}/{service}",
      summary: "Deploy image {image} to Cloud Run service {service} in {projectId}/{region}",
      fields: [
        textField("projectId", "Project"),
        textField("region"),
        textField("service"),
        textField("image", "Container image"),
      ],
    },
    "deploy {projectId}/{region}/{service} {image:tail8}",
  ),
  // D3's: the GKE restart stays un-offered (its reader is code-execution class, OR-D1-1).
  withConfirm(row("gcp_gke_workload_restart", "gcp.gke.workload.restart", "mesh", 4), {
    template: "restart {projectId}/{cluster}/{namespace}/{deployment}",
  }),
  // D3c: a restart and a scale of a DEPLOYMENT, each with a typed preview, the deployment's current
  // state (`k8s_deployment_get`) and a confirm that names the context, namespace and deployment.
  // `context` and `namespace` are required connector inputs (0.11.0) and the runner re-checks the
  // pair against the owner's V86 approval for every child. A restart of any other resource type has
  // no reader, hence no before-state, hence is refused on every door.
  withConfirm(
    withBefore(
      withPreview(row("k8s_rollout_restart", "kubernetes.rollout.restart", "mesh", 4), {
        target: "{context}/{namespace}/{name}",
        summary:
          "Restart the rollout of {resourceType} {name} in namespace {namespace} of context {context}",
        fields: [
          textField("context", "Context"),
          textField("namespace", "Namespace"),
          textField("resourceType", "Resource type"),
          textField("name", "Name"),
        ],
      }),
      {
        tool: "k8s_deployment_get",
        argKeys: ["context", "namespace", "resourceType", "name"],
        args: k8sRestartReadArgs,
        select: selectK8sDeployment("restart", "name"),
      },
    ),
    { template: "restart {context}/{namespace}/{name}" },
  ),
  withConfirm(
    withBefore(
      withPreview(row("k8s_deployment_scale", "kubernetes.deployment.scale", "mesh", 4), {
        target: "{context}/{namespace}/{deploymentName}",
        summary:
          "Scale deployment {deploymentName} in namespace {namespace} of context {context} to {replicas} replicas",
        fields: [
          textField("context", "Context"),
          textField("namespace", "Namespace"),
          textField("deploymentName", "Deployment"),
          textField("replicas", "Replicas"),
        ],
      }),
      {
        tool: "k8s_deployment_get",
        argKeys: ["context", "namespace", "deploymentName", "replicas"],
        args: k8sScaleReadArgs,
        select: selectK8sDeployment("scale", "deploymentName"),
      },
    ),
    { template: "scale {context}/{namespace}/{deploymentName} to {replicas}" },
  ),
  // Never offered to the model (destroy-class, OR-D2-2 spirit): a pod delete stays an owner action.
  withConfirm(row("k8s_pod_delete", "kubernetes.pod.delete", "mesh", 4), {
    template: "delete {context}/{namespace}/{podName}",
  }),
  // D2: the three plan-bound IaC writes (`iac-bound.ts`). Each is BOUND to the identity of the plan
  // or change set its prepare tool made, as the GATEWAY settled it (a saved plan moved, hashed and
  // rendered by `terraform show -json` in a child with no network and no credential; a change set
  // cross-checked against the input), and shows the owner that rendering in full or is refused.
  // `planFile`, `planSha256` and `changeSetId` are the gateway's: the preview never names them. The
  // act door denies all three (class iac): its consent display has no plan.
  withConfirm(
    withBound(
      withPreview(row("iac_terraform_apply", "iac.terraform.apply", "mesh", 4), {
        target: "{workingDirectory}",
        summary:
          "Apply the saved Terraform plan for {workingDirectory} (the plan below, pinned by its hash)",
        fields: [textField("workingDirectory", "Working directory")],
      }),
      TERRAFORM_APPLY_BOUND,
    ),
    { template: "apply {workingDirectory}" },
  ),
  withConfirm(
    withBound(
      withPreview(row("iac_terraform_destroy", "iac.terraform.destroy", "mesh", 4), {
        target: "{workingDirectory}",
        summary:
          "DESTROY: apply the saved Terraform destroy plan for {workingDirectory} (the plan below, pinned by its hash)",
        fields: [textField("workingDirectory", "Working directory")],
      }),
      TERRAFORM_DESTROY_BOUND,
    ),
    { template: "destroy {workingDirectory}" },
  ),
  withConfirm(
    withBound(
      withPreview(row("iac_cloudformation_deploy", "iac.cloudformation.deploy", "mesh", 4), {
        target: "{stackName}",
        summary:
          "Execute the CloudFormation change set made for stack {stackName} and exactly this template",
        fields: [
          textField("stackName", "Stack"),
          textField("capabilities", "Capabilities", "(none)"),
          textField("templateBody", "Template"),
        ],
      }),
      CFN_DEPLOY_BOUND,
    ),
    { template: "deploy {stackName}" },
  ),
  // Refused on every door before any prompt (D2, OR-W34-2): Pulumi saved update plans are
  // documented as experimental, so there is no plan an apply could be bound to. The connector
  // rejects it too, but only AFTER the prompt; the gate refuses first.
  withRefusal(
    withConfirm(row("iac_pulumi_up", "iac.pulumi.up", "mesh", 4), {
      template: "up {workingDirectory}",
    }),
    "iac.pulumi.up: refused (saved update plans are experimental, OR-W34-2)",
  ),
  // Connectors 0.9.0. The change-set discard is a WRITE (connector fix 19) that only the gateway's
  // own cleanup of a change set it created would ever call; until then it is an owner-typed,
  // never-offered row.
  withConfirm(
    row("iac_cloudformation_changeset_discard", "iac.cloudformation.changeset.discard", "mesh", 4),
    { template: "discard {stackName}" },
  ),
  // D3a: the sixth bound row. Bound to the plan `k8s_manifest_plan` made, as the GATEWAY settled it
  // (both hashes computed by the gateway; its parse of the manifest must agree with the connector's
  // scan); the owner sees the manifest, the objects and the diff in full and types the DERIVED
  // target (`<context>/<namespace> <Kind>/<name>`, or the object count and a hash prefix).
  // `planSha256` and `diffSha256` are the gateway's: the preview never names them. The act door
  // denies it (class k8s): its consent display has no plan.
  withConfirm(
    withBound(
      withPreview(row("k8s_manifest_apply", "kubernetes.manifest.apply", "mesh", 4), {
        target: "{context}/{namespace}",
        summary: "Apply the manifest below to namespace {namespace} of context {context}",
        fields: [
          textField("context", "Context"),
          textField("namespace", "Namespace"),
          textField("manifest", "Manifest"),
        ],
      }),
      K8S_APPLY_BOUND,
    ),
    { template: "apply {target}", derive: "k8s-target" },
  ),
];

// packages/gateway/src/connectors/connector-writes/cloud-infra.ts
import {
  ec2InstanceReadArgs,
  ecsServiceReadArgs,
  lambdaListReadArgs,
  selectEc2Instance,
  selectEcsService,
  selectLambdaFunction,
} from "./cloud-readers.ts";
import {
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withConfirm,
  withPreview,
} from "./types.ts";

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
  withConfirm(
    withPreview(row("azure_app_service_restart", "azure.app_service.restart", "mesh", 4), {
      target: "{resourceGroup}/{name}",
      summary: "Restart Azure App Service {name} in resource group {resourceGroup}",
      fields: [
        textField("subscriptionId", "Subscription"),
        textField("resourceGroup", "Resource group"),
        textField("name", "App Service"),
      ],
    }),
    { template: "restart {resourceGroup}/{name}" },
  ),
  withConfirm(
    withPreview(row("azure_aks_node_pool_scale", "azure.aks.node_pool.scale", "mesh", 4), {
      target: "{resourceGroup}/{clusterName}/{poolName}",
      summary: "Scale AKS node pool {poolName} of cluster {clusterName} to {nodeCount} nodes",
      fields: [
        textField("subscriptionId", "Subscription"),
        textField("resourceGroup", "Resource group"),
        textField("clusterName", "Cluster"),
        textField("poolName", "Node pool"),
        textField("nodeCount", "New node count"),
      ],
    }),
    { template: "scale {resourceGroup}/{clusterName}/{poolName} to {nodeCount}" },
  ),
  // The confirm text names the image (its last 8 characters, so a long digest stays typeable): the
  // deploy's blast is the image, which the old text did not name (D1 § 2.7).
  withConfirm(
    withPreview(row("gcp_cloud_run_deploy", "gcp.cloud_run.deploy", "mesh", 4), {
      target: "{projectId}/{region}/{service}",
      summary: "Deploy image {image} to Cloud Run service {service} in {projectId}/{region}",
      fields: [
        textField("projectId", "Project"),
        textField("region"),
        textField("service"),
        textField("image", "Container image"),
      ],
    }),
    { template: "deploy {projectId}/{region}/{service} {image:tail8}" },
  ),
  // D3's: the Kubernetes and GKE rows wait for the sandbox grants they need to run at all.
  withConfirm(row("gcp_gke_workload_restart", "gcp.gke.workload.restart", "mesh", 4), {
    template: "restart {projectId}/{cluster}/{namespace}/{deployment}",
  }),
  withConfirm(row("k8s_rollout_restart", "kubernetes.rollout.restart", "mesh", 4), {
    template: "restart {resourceType}/{name}",
  }),
  withConfirm(row("k8s_deployment_scale", "kubernetes.deployment.scale", "mesh", 4), {
    template: "scale {deploymentName} to {replicas}",
  }),
  withConfirm(row("k8s_pod_delete", "kubernetes.pod.delete", "mesh", 4), {
    template: "delete {podName}",
  }),
  // D2's.
  withConfirm(row("iac_terraform_apply", "iac.terraform.apply", "mesh", 4), {
    template: "apply {workingDirectory}",
  }),
  withConfirm(row("iac_terraform_destroy", "iac.terraform.destroy", "mesh", 4), {
    template: "destroy {workingDirectory}",
  }),
  withConfirm(row("iac_cloudformation_deploy", "iac.cloudformation.deploy", "mesh", 4), {
    template: "deploy {stackName}",
  }),
  withConfirm(row("iac_pulumi_up", "iac.pulumi.up", "mesh", 4), {
    template: "up {workingDirectory}",
  }),
  // Connectors 0.9.0. The change-set discard is a WRITE (connector fix 19) that only the gateway's
  // own cleanup of a change set it created would ever call; until then it is an owner-typed,
  // never-offered row. `k8s_manifest_apply` is D3's: classified so the build stays green, with
  // placeholder confirm text, never offered, denied on the act door; D3 owns every behaviour.
  withConfirm(
    row("iac_cloudformation_changeset_discard", "iac.cloudformation.changeset.discard", "mesh", 4),
    { template: "discard {stackName}" },
  ),
  withConfirm(row("k8s_manifest_apply", "kubernetes.manifest.apply", "mesh", 4), {
    template: "apply {namespace}",
  }),
];

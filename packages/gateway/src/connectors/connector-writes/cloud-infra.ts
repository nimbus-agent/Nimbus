// packages/gateway/src/connectors/connector-writes/cloud-infra.ts
import { type ConnectorWriteRow, row, withConfirm } from "./types.ts";

export const CLOUD_INFRA_ROWS: readonly ConnectorWriteRow[] = [
  withConfirm(row("aws_ecs_service_update", "aws.ecs.service.update", "mesh", 4), {
    template: "{cluster}/{service}",
  }),
  withConfirm(row("aws_lambda_invoke", "aws.lambda.invoke", "mesh", 4), {
    template: "{functionName}",
  }),
  withConfirm(row("aws_ec2_instance_stop", "aws.ec2.instance.stop", "mesh", 4), {
    template: "{instanceIds}",
  }),
  withConfirm(row("aws_ec2_instance_start", "aws.ec2.instance.start", "mesh", 4), {
    template: "{instanceIds}",
  }),
  withConfirm(row("azure_app_service_restart", "azure.app_service.restart", "mesh", 4), {
    template: "{resourceGroup}/{name}",
  }),
  withConfirm(row("azure_aks_node_pool_scale", "azure.aks.node_pool.scale", "mesh", 4), {
    template: "{resourceGroup}/{clusterName}/{poolName}",
  }),
  withConfirm(row("gcp_cloud_run_deploy", "gcp.cloud_run.deploy", "mesh", 4), {
    template: "{projectId}/{region}/{service}",
  }),
  withConfirm(row("gcp_gke_workload_restart", "gcp.gke.workload.restart", "mesh", 4), {
    template: "{projectId}/{cluster}/{namespace}/{deployment}",
  }),
  withConfirm(row("k8s_rollout_restart", "kubernetes.rollout.restart", "mesh", 4), {
    template: "{resourceType}/{name}",
  }),
  withConfirm(row("k8s_deployment_scale", "kubernetes.deployment.scale", "mesh", 4), {
    template: "{deploymentName}",
  }),
  withConfirm(row("k8s_pod_delete", "kubernetes.pod.delete", "mesh", 4), { template: "{podName}" }),
  withConfirm(row("iac_terraform_apply", "iac.terraform.apply", "mesh", 4), {
    template: "{workingDirectory}",
  }),
  withConfirm(row("iac_terraform_destroy", "iac.terraform.destroy", "mesh", 4), {
    template: "{workingDirectory}",
  }),
  withConfirm(row("iac_cloudformation_deploy", "iac.cloudformation.deploy", "mesh", 4), {
    template: "{stackName}",
  }),
  withConfirm(row("iac_pulumi_up", "iac.pulumi.up", "mesh", 4), { template: "{workingDirectory}" }),
];

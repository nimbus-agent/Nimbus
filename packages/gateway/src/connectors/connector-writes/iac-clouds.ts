// packages/gateway/src/connectors/connector-writes/iac-clouds.ts
// What each cloud the owner can grant to the iac children means in concrete terms (Phase 9.7 D2,
// section 2.7): the environment variable NAMES its credential travels in (never values), and the
// EXACT hosts a Terraform plan or apply, or a CloudFormation call, may reach. Pure tables, shared
// by the enable prompt (which shows them) and the runner (which grants them), so the two cannot
// drift. Wildcard patterns live only in `lazy-mesh/first-party-manifests.ts` (I50), reached through
// `iacWildcardHosts`.
//
// UNVERIFIED (OR-D2 stated bound): the host lists are drawn from the vendors' documented endpoints.
// No credentialed plan was run against a real account, so a provider that needs another host fails
// closed on Linux (the forwarder refuses it) and the owner adds it with `--net`. There are no
// registry hosts: provider and module downloads are not allowed (the owner runs `terraform init`).
import type { IacCloud } from "./iac-grants.ts";

/** The names (never the values) of the variables each cloud's credential reaches the child in. */
export const IAC_CLOUD_ENV_NAMES: Readonly<Record<IacCloud, readonly string[]>> = Object.freeze({
  aws: Object.freeze([
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
    "AWS_PROFILE",
  ]),
  azure: Object.freeze(["ARM_TENANT_ID", "ARM_CLIENT_ID", "ARM_CLIENT_SECRET"]),
  gcp: Object.freeze(["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE"]),
});

const SAFE_REGION = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isSafeIacRegion(value: string): boolean {
  return SAFE_REGION.test(value);
}

function awsSuffix(region: string): string {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

/** The exact hosts of the Terraform `plan` and `apply` children for the granted clouds. */
export function iacTerraformHosts(clouds: readonly IacCloud[]): string[] {
  const hosts: string[] = [];
  if (clouds.includes("aws")) {
    hosts.push(
      "iam.amazonaws.com",
      "sts.amazonaws.com",
      "s3.amazonaws.com",
      "route53.amazonaws.com",
      "cloudfront.amazonaws.com",
    );
  }
  if (clouds.includes("azure")) hosts.push("management.azure.com", "login.microsoftonline.com");
  if (clouds.includes("gcp")) hosts.push("oauth2.googleapis.com", "www.googleapis.com");
  return hosts;
}

/** The hosts of the CloudFormation child: its own region's endpoint and the STS endpoints. */
export function iacCfnHosts(region: string): string[] {
  if (!isSafeIacRegion(region)) return [];
  const s = awsSuffix(region);
  return [`cloudformation.${region}.${s}`, `sts.${region}.${s}`, "sts.amazonaws.com"];
}

/** One owner-typed extra host (`host` or `host:port`): lower case, no wildcard, no scheme or path. */
const EXTRA_HOST = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;

export function isValidIacExtraHost(value: string): boolean {
  if (!EXTRA_HOST.test(value) || value.includes("..")) return false;
  const port = value.split(":")[1];
  return port === undefined || (Number(port) >= 1 && Number(port) <= 65_535);
}

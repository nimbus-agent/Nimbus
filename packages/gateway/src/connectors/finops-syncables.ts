import { DEFAULT_COST_AWS_CONFIG, type NimbusCostAwsConfig } from "../config/cost-aws-toml.ts";
import {
  DEFAULT_COST_BITBUCKET_CONFIG,
  type NimbusCostBitbucketConfig,
} from "../config/cost-bitbucket-toml.ts";
import { DEFAULT_COST_GCP_CONFIG, type NimbusCostGcpConfig } from "../config/cost-gcp-toml.ts";
import {
  DEFAULT_COST_GITLAB_CONFIG,
  type NimbusCostGitlabConfig,
} from "../config/cost-gitlab-toml.ts";
import {
  DEFAULT_COST_JENKINS_CONFIG,
  type NimbusCostJenkinsConfig,
} from "../config/cost-jenkins-toml.ts";
import type { Syncable } from "../sync/types.ts";
import { createAnthropicCostSyncable } from "./anthropic-cost-sync.ts";
import { createAwsBillingCostSyncable } from "./aws-billing-cost-sync.ts";
import { createBitbucketCostSyncable } from "./bitbucket-cost-sync.ts";
import { createGcpBillingCostSyncable } from "./gcp-billing-cost-sync.ts";
import { createGithubBillingCostSyncable } from "./github-billing-cost-sync.ts";
import { createGitlabCostSyncable } from "./gitlab-cost-sync.ts";
import { createJenkinsCostSyncable } from "./jenkins-cost-sync.ts";
import { createK8sCostSyncable } from "./k8s-cost-sync.ts";
import { createOpenaiCostSyncable } from "./openai-cost-sync.ts";
import { createVantageSyncable } from "./vantage-sync.ts";

/** What the FinOps syncables read per sync; an absent member means its default. */
export type FinopsSyncOptions = {
  /** `[finops] max_series`. */
  readonly maxSeries?: () => number;
  /** `[cost.github] orgs` (Phase 7 slice 5); absent or empty means no GitHub billing sync. */
  readonly githubOrgs?: () => readonly string[];
  /** `[cost.gitlab]` (Phase 7 slice 8); absent or no groups means no GitLab compute-minute sync. */
  readonly gitlab?: () => NimbusCostGitlabConfig | null;
  /** `[cost.bitbucket]` (Phase 7 slice 9); absent or no workspaces means no Bitbucket Pipelines sync. */
  readonly bitbucket?: () => NimbusCostBitbucketConfig | null;
  /** `[cost.jenkins]` (slice 10); absent or no table means no Jenkins build-minute sync. */
  readonly jenkins?: () => NimbusCostJenkinsConfig | null;
  /** `[cost.aws]` (slice 11a); absent or no export means no AWS cost sync. */
  readonly aws?: () => NimbusCostAwsConfig | null;
  /** `[cost.gcp]` (slice 13); absent or no export_table means no GCP cost sync. */
  readonly gcp?: () => NimbusCostGcpConfig | null;
};

/**
 * Registers the FinOps syncables: Vantage, then OpenCost and Kubecost (Phase 10), then GitHub billing usage
 * (Phase 7 slice 5), then OpenAI and Anthropic organization costs (slice 6). Then GitLab compute minutes (slice 8) and Bitbucket Pipelines minutes (slice 9). Each source runs on its own timer and fails on its own: an unconfigured one is skipped by
 * the scheduler's configured check.
 */
export function registerFinopsSyncables(
  scheduler: { register(syncable: Syncable): void },
  finops: FinopsSyncOptions | undefined,
): void {
  const maxSeries = finops?.maxSeries;
  const options = maxSeries === undefined ? {} : { maxSeries };
  scheduler.register(createVantageSyncable(options));
  scheduler.register(createK8sCostSyncable("opencost", options));
  scheduler.register(createK8sCostSyncable("kubecost", options));
  scheduler.register(
    createGithubBillingCostSyncable({ githubOrgs: finops?.githubOrgs ?? (() => []) }),
  );
  scheduler.register(createOpenaiCostSyncable());
  scheduler.register(createAnthropicCostSyncable());
  scheduler.register(
    createGitlabCostSyncable({ gitlab: finops?.gitlab ?? (() => DEFAULT_COST_GITLAB_CONFIG) }),
  );
  scheduler.register(
    createBitbucketCostSyncable({
      bitbucket: finops?.bitbucket ?? (() => DEFAULT_COST_BITBUCKET_CONFIG),
    }),
  );
  scheduler.register(
    createJenkinsCostSyncable({ jenkins: finops?.jenkins ?? (() => DEFAULT_COST_JENKINS_CONFIG) }),
  );
  scheduler.register(
    createAwsBillingCostSyncable({ aws: finops?.aws ?? (() => DEFAULT_COST_AWS_CONFIG) }),
  );
  scheduler.register(
    createGcpBillingCostSyncable({ gcp: finops?.gcp ?? (() => DEFAULT_COST_GCP_CONFIG) }),
  );
}

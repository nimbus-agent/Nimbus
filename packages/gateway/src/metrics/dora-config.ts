export type DoraProvider = "github" | "gitlab" | "bitbucket" | "jenkins" | "circleci";

export type ParsedDoraRepoUrn = {
  readonly provider: DoraProvider;
  readonly providerId: string;
};

export type ServiceConfig = {
  readonly serviceId: string;
  readonly repos: readonly ParsedDoraRepoUrn[];
  readonly pagerdutyServices: readonly string[];
  readonly deployWorkflowPattern: RegExp;
  readonly incidentWindowMinutes: number;
  readonly excludePrLabels: readonly string[];
  readonly deployEnvironments: readonly string[];
  readonly severityP1Aliases: readonly string[];
};

export const DEFAULT_DEPLOY_WORKFLOW_PATTERN = "^[Dd]eploy";
export const DEFAULT_INCIDENT_WINDOW_MINUTES = 60;
export const DEFAULT_EXCLUDE_PR_LABELS: readonly string[] = ["revert"];
export const DEFAULT_DEPLOY_ENVIRONMENTS: readonly string[] = ["prod"];

const DEPLOY_ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export function isValidDeployEnvironmentName(name: string): boolean {
  return DEPLOY_ENV_NAME_PATTERN.test(name);
}

const KNOWN_PROVIDERS: readonly DoraProvider[] = [
  "github",
  "gitlab",
  "bitbucket",
  "jenkins",
  "circleci",
];

export function parseDoraRepoUrn(raw: string): ParsedDoraRepoUrn {
  const colon = raw.indexOf(":");
  if (colon <= 0) {
    throw new Error(`invalid URN '${raw}': missing 'provider:id' separator`);
  }
  const provider = raw.slice(0, colon);
  const providerId = raw.slice(colon + 1);
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `unknown provider '${provider}' in URN '${raw}'. Known: ${KNOWN_PROVIDERS.join(", ")}`,
    );
  }
  if (providerId.length === 0) {
    throw new Error(`invalid URN '${raw}': empty provider-specific id`);
  }
  return { provider: provider as DoraProvider, providerId };
}

export function providerServiceColumns(provider: DoraProvider): {
  prServices: readonly string[];
  ciServices: readonly string[];
} {
  switch (provider) {
    case "github":
      return { prServices: ["github"], ciServices: ["github_actions"] };
    case "gitlab":
      return { prServices: ["gitlab"], ciServices: ["gitlab"] };
    case "bitbucket":
      return { prServices: ["bitbucket"], ciServices: ["bitbucket"] };
    case "jenkins":
      return { prServices: [], ciServices: ["jenkins"] };
    case "circleci":
      return { prServices: [], ciServices: ["circleci"] };
  }
}

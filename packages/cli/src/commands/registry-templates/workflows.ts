/**
 * The two GitHub Actions workflows `nimbus registry maintain init --github` writes into a registry
 * repository (design § 7.4, § 7.5). Every `uses:` is pinned to a 40-hex commit SHA with a version
 * comment, because the `nimbus-agent` org enforces `sha_pinning_required` and a tag pin fails at
 * startup.
 */

/** `actions/checkout`, pinned to the SHA this repository's own workflows use. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const CHECKOUT_VERSION = "v7.0.1";

/** The registry action, referenced by path in the Nimbus repository. */
export const REGISTRY_ACTION_PATH = "nimbus-agent/Nimbus/packages/github-actions/registry-action";

/** The environment secret the sign workflow passes as the action's `root-key` input. */
export const ROOT_KEY_SECRET = "NIMBUS_REGISTRY_ROOT_KEY";

/** The environment whose required reviewers approve every signing run. */
export const SIGNING_ENVIRONMENT = "registry-signing";

/** Which Nimbus commit the registry action is pinned to, and the Nimbus version it shipped in. */
export interface ActionPin {
  /** A 40-hex commit SHA of the Nimbus repository. */
  commit: string;
  /** The Nimbus version that commit belongs to, for the pin's comment. */
  version: string;
}

function actionUses(pin: ActionPin): string {
  return `${REGISTRY_ACTION_PATH}@${pin.commit} # v${pin.version}`;
}

/**
 * `registry-check.yml`: a reviewer aid on every pull request, with no secrets and a read-only token.
 * Full history (`fetch-depth: 0`) so the action can find the pull request's merge base; no
 * persisted credentials, since nothing in this job pushes (so the repository must be public for its
 * fetches to work). `defaultBranch` is a name `init` already validated as YAML- and ref-safe; it is
 * still emitted JSON-quoted so a numeric-looking name stays a string.
 */
export function registryCheckWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Validates a publish pull request against the signed index on gh-pages and summarises it
# for the reviewer. A green check is a reviewer aid, not the boundary: a pull request can edit
# this file. The boundary is the sign workflow and its required approval.
name: Registry check

on:
  pull_request:
    branches: [${JSON.stringify(defaultBranch)}]

permissions:
  contents: read

jobs:
  check:
    name: Check the publish request
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Check
        uses: ${actionUses(pin)}
        with:
          mode: check
`;
}

/**
 * `registry-sign.yml`: the content boundary. Runs behind the `registry-signing` environment's
 * required reviewers, one run at a time, and pushes the signed site to `gh-pages` with the job's
 * token, which is why its checkout keeps the persisted credentials.
 */
export function registrySignWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Validates every unsigned extension version on ${defaultBranch}, signs the index with the
# registry root key and pushes the site to gh-pages. Before approving a run, check that run's
# workflow diff:
# the required approval is what stops a changed copy of this file from using the key.
name: Registry sign

on:
  push:
    branches: [${JSON.stringify(defaultBranch)}]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: registry-sign
  cancel-in-progress: false

jobs:
  sign:
    name: Sign and publish the index
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    environment: ${SIGNING_ENVIRONMENT}
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}

      - name: Sign
        uses: ${actionUses(pin)}
        with:
          mode: sign
          # Named, not read from origin's HEAD: that is gh-pages when it was pushed first to an
          # empty repository, and a run reading it would sign nothing.
          default-branch: ${JSON.stringify(defaultBranch)}
          root-key: \${{ secrets.${ROOT_KEY_SECRET} }}
`;
}

/**
 * The two GitHub Actions workflows `nimbus trust maintain init --github` writes into the Nimbus
 * trust-feed repository. Same shape as a registry's (`registry-templates/workflows.ts`): every `uses:`
 * pinned to a 40-hex commit SHA, a read-only check on every pull request, and a sign job behind a
 * protected environment that alone holds the trust root key.
 */
import {
  type ActionPin,
  actionUses,
  CHECKOUT_ACTION,
  CHECKOUT_VERSION,
} from "../registry-templates/workflows.ts";

/** The environment secret the sign workflow passes as the action's `root-key` input. */
export const TRUST_ROOT_KEY_SECRET = "NIMBUS_TRUST_ROOT_KEY";

/** The environment whose required reviewers approve every trust-feed signing run. */
export const TRUST_SIGNING_ENVIRONMENT = "trust-signing";

/** `trust-check.yml`: a reviewer aid on every pull request, with no secrets and a read-only token. */
export function trustCheckWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Summarises what a pull request changes in the Nimbus trust feed, for the reviewer. A green
# check is a reviewer aid, not the boundary: a pull request can edit this file. The boundary is
# merging and the trust-sign workflow's required approval.
name: Trust feed check

on:
  pull_request:
    branches: [${JSON.stringify(defaultBranch)}]

permissions:
  contents: read

jobs:
  check:
    name: Check the trust feed change
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
          mode: trust-check
`;
}

/**
 * `trust-sign.yml`: the content boundary. Runs behind the `trust-signing` environment's required
 * reviewers, one run at a time, and pushes the signed `trust.json` to `gh-pages`.
 */
export function trustSignWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Builds the next Nimbus trust feed from ${defaultBranch}'s publishers/, requests/ and
# statements/, signs it with the trust root key and pushes trust.json to gh-pages. Every Nimbus
# install applies what this signs: before approving a run, read that run's diff and workflow.
name: Trust feed sign

on:
  push:
    branches: [${JSON.stringify(defaultBranch)}]
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: trust-sign
  cancel-in-progress: false

jobs:
  sign:
    name: Sign and publish trust.json
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    environment: ${TRUST_SIGNING_ENVIRONMENT}
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}

      - name: Sign
        uses: ${actionUses(pin)}
        with:
          mode: trust-sign
          default-branch: ${JSON.stringify(defaultBranch)}
          root-key: \${{ secrets.${TRUST_ROOT_KEY_SECRET} }}
`;
}

/**
 * The two GitHub Actions workflows `nimbus registry maintain init --github` writes into a registry
 * repository (design § 7.4, § 7.5). Every `uses:` is pinned to a 40-hex commit SHA with a version
 * comment, because the `nimbus-agent` org enforces `sha_pinning_required` and a tag pin fails at
 * startup.
 *
 * Extension code (a version's eval suites) runs only in jobs that hold no secret and no token
 * beyond a read-only `contents` permission: the sign workflow's `score` job and the check job.
 * The `sign` job, which holds the root key, reads the score job's `scores.json` as untrusted input.
 */

/** `actions/checkout`, pinned to the SHA this repository's own workflows use. */
export const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
export const CHECKOUT_VERSION = "v7.0.1";

/** `actions/upload-artifact`, pinned (with its version comment) as this repository's workflows pin it. */
export const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1";
/** `actions/download-artifact`, pinned (with its version comment) as this repository's workflows pin it. */
export const DOWNLOAD_ARTIFACT_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1";

/** The artifact the score job uploads `scores.json` as, and the sign job downloads. */
export const SCORES_ARTIFACT = "registry-scores";

/** The registry action, referenced by path in the Nimbus repository. */
export const REGISTRY_ACTION_PATH = "nimbus-agent/Nimbus/packages/github-actions/registry-action";

/** The environment secret the sign workflow passes as the action's `root-key` input. */
export const ROOT_KEY_SECRET = "NIMBUS_REGISTRY_ROOT_KEY";

/** The environment whose required reviewers approve every signing run. */
export const SIGNING_ENVIRONMENT = "registry-signing";

/** The Linux gateway release asset the score and check jobs run eval suites with. */
const GATEWAY_ASSET = "nimbus-gateway-linux-x64";

/** The action's `nimbus-gateway` input: an absolute path, as the action requires. */
const GATEWAY_INPUT = `\${{ github.workspace }}/${GATEWAY_ASSET}`;

/** Which Nimbus commit the registry action is pinned to, and the Nimbus version it shipped in. */
export interface ActionPin {
  /** A 40-hex commit SHA of the Nimbus repository. */
  commit: string;
  /** The Nimbus version that commit belongs to, for the pin's comment. */
  version: string;
}

export function actionUses(pin: ActionPin): string {
  return `${REGISTRY_ACTION_PATH}@${pin.commit} # v${pin.version}`;
}

/**
 * The steps that let a job run eval suites: bubblewrap with unprivileged user namespaces, and the
 * gateway of the pinned Nimbus version. Inlined, because a registry repository has none of this
 * repository's scripts. System changes run under `sudo`; the smoke probe runs as the runner user,
 * because root bypasses the userns restriction and a probe under `sudo` would pass whether or not
 * the `sysctl` writes took effect. The bind set mirrors `scripts/linux/install-sandbox-deps.sh`.
 * Only the gateway's own line of `SHA256SUMS` is checked: `sha256sum -c SHA256SUMS` fails on every
 * release asset the job did not download.
 */
function gatewaySetupSteps(pin: ActionPin): string {
  return `      - name: Set up the sandbox
        # System changes need root. The probe must NOT run as root: root bypasses the userns
        # restriction, so a probe under sudo would pass even if the sysctl writes did not apply.
        run: |
          sudo rm -f /etc/apt/sources.list.d/*microsoft* /etc/apt/sources.list.d/*azure*
          sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Acquire::Retries=3 update -qq < /dev/null
          sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -o Acquire::Retries=3 install -y -qq bubblewrap < /dev/null
          sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
          sudo sysctl -w kernel.unprivileged_userns_clone=1 || true
          lib64=()
          if [ -d /lib64 ]; then lib64=(--ro-bind /lib64 /lib64); fi
          bwrap --unshare-user --unshare-net --new-session --ro-bind /usr /usr --ro-bind /etc /etc --ro-bind /lib /lib "\${lib64[@]}" --proc /proc --dev /dev --tmpfs /tmp /usr/bin/true

      - name: Download the Nimbus gateway
        # Checks only this asset's line of SHA256SUMS; checking the whole file fails on every
        # release asset this job did not download.
        run: |
          base="https://github.com/nimbus-agent/Nimbus/releases/download/v${pin.version}"
          curl -fsSL --retry 3 -o ${GATEWAY_ASSET} "$base/${GATEWAY_ASSET}"
          curl -fsSL --retry 3 -o SHA256SUMS "$base/SHA256SUMS"
          grep -E '^[0-9a-f]{64}  ${GATEWAY_ASSET}$' SHA256SUMS > CHECKSUM.txt
          test "$(wc -l < CHECKSUM.txt)" -eq 1
          sha256sum -c CHECKSUM.txt
          chmod +x ${GATEWAY_ASSET}
`;
}

/**
 * `registry-check.yml`: a reviewer aid on every pull request, with no secrets and a read-only token.
 * Full history (`fetch-depth: 0`) so the action can find the pull request's merge base; no
 * persisted credentials, since nothing in this job pushes (so the repository must be public for its
 * fetches to work). The job runs the pull request's eval suites and reports the score, so it passes
 * no `github-token` (the action refuses one beside `nimbus-gateway`); build provenance is verified
 * by the sign job. `defaultBranch` is a name `init` already validated as YAML- and ref-safe; it is
 * still emitted JSON-quoted so a numeric-looking name stays a string.
 */
export function registryCheckWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Validates a publish pull request against the signed index on gh-pages, runs the new
# version's eval suites in the sandbox and summarises both for the reviewer. A green check is a
# reviewer aid, not the boundary: a pull request can edit this file. The boundary is the sign
# workflow and its required approval.
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
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}
        with:
          fetch-depth: 0
          persist-credentials: false

${gatewaySetupSteps(pin)}
      - name: Check
        uses: ${actionUses(pin)}
        with:
          mode: check
          # Runs the version's eval suites, so this job holds no token; the sign job checks
          # build provenance.
          nimbus-gateway: ${GATEWAY_INPUT}
`;
}

/**
 * `registry-sign.yml`: the content boundary. The `score` job runs every unsigned version's eval
 * suites with no environment, no secret and a read-only token, and uploads `scores.json`; the
 * `sign` job then runs behind the `registry-signing` environment's required reviewers, one run at a
 * time, reads that file as untrusted input, and pushes the signed site to `gh-pages` with the job's
 * token, which is why its checkout keeps the persisted credentials.
 */
export function registrySignWorkflow(pin: ActionPin, defaultBranch: string): string {
  return `# Validates every unsigned extension version on ${defaultBranch}, runs their eval suites in a
# job that holds no secret, signs the index with the registry root key and pushes the site to
# gh-pages. Before approving a run, check that run's workflow diff:
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
  score:
    name: Score the eval suites
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    # Runs extension code: no environment, no secret, no token beyond read-only contents.
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}
        with:
          persist-credentials: false

${gatewaySetupSteps(pin)}
      - name: Score
        uses: ${actionUses(pin)}
        with:
          mode: score
          default-branch: ${JSON.stringify(defaultBranch)}
          nimbus-gateway: ${GATEWAY_INPUT}

      - name: Upload the scores
        uses: ${UPLOAD_ARTIFACT_ACTION}
        with:
          name: ${SCORES_ARTIFACT}
          path: scores.json
          if-no-files-found: error

  sign:
    name: Sign and publish the index
    needs: score
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    environment: ${SIGNING_ENVIRONMENT}
    steps:
      - name: Checkout
        uses: ${CHECKOUT_ACTION} # ${CHECKOUT_VERSION}

      - name: Download the scores
        uses: ${DOWNLOAD_ARTIFACT_ACTION}
        with:
          name: ${SCORES_ARTIFACT}

      - name: Sign
        uses: ${actionUses(pin)}
        with:
          mode: sign
          # Named, not read from origin's HEAD: that is gh-pages when it was pushed first to an
          # empty repository, and a run reading it would sign nothing.
          default-branch: ${JSON.stringify(defaultBranch)}
          root-key: \${{ secrets.${ROOT_KEY_SECRET} }}
          # Lets the sign job verify a version's build provenance (gh attestation verify).
          github-token: \${{ github.token }}
          # Untrusted input: each entry is bound to its version's id, version and package digest.
          scores: scores.json
`;
}

/**
 * Static manifest registry for first-party connectors spawned by
 * `lazy-mesh/` (T2 PR 1 §6).
 *
 * **Why this file exists (and why it is hard-coded for PR 1):**
 *
 * The T2 sequencing spec calls for each first-party connector to ship its
 * own `nimbus.extension.json` declaring `permissions.network` and
 * `permissions.filesystem`. That mechanical migration is a Task 14
 * deliverable. PR 1 needs the I15 wiring (every lazy-mesh ServerSpec
 * sandboxed) to land BEFORE the manifests exist on disk, otherwise we
 * either ship I15 with the wiring inert (defeats the invariant), or block
 * the sandbox PR on the 30-file manifest sweep (defeats the sequencing).
 *
 * Resolution: this file is the single source of truth for first-party
 * connector permissions until a follow-up replaces it with disk-loaded
 * manifests. Each row mirrors what the connector declares in its
 * `nimbus.extension.json` on disk (sibling files added in Task 14). Hosts
 * are conservative — when in doubt, we leave a row default-deny rather
 * than over-grant.
 *
 * **Known limitations carried forward as Task 14 follow-ups:**
 *
 * - `aws` / `azure` / `gcp` declare the region-agnostic control-plane
 *   hosts only; non-default regions / data-plane hosts (S3 buckets,
 *   storage accounts, BigQuery datasets) fail under the sandbox until a
 *   structured region matrix is added.
 * - `kubernetes` is default-deny — kubeconfig YAML parsing to extract
 *   the API server hostname is deferred.
 * - `datadog` SaaS default is `api.datadoghq.com`; non-`us1` sites
 *   (`DD_SITE` = `eu1` / `us3` / `us5` / `ap1` / `gov`) are not yet
 *   mapped at spawn time.
 * - `sentry` self-hosted (`sentry.url` configured) and `bitbucket`
 *   Server are not yet runtime-merged.
 * - `gitlab` self-hosted (`GITLAB_API_BASE_URL`) and `jira` /
 *   `confluence` per-tenant cloud URLs (`JIRA_BASE_URL` /
 *   `CONFLUENCE_BASE_URL`) are not yet runtime-merged either; only the
 *   SaaS / API gateway host is in the static list.
 *
 * Connectors whose target host is *always* user-configured (`jenkins`,
 * `grafana`) are runtime-merged today by the corresponding
 * `ensure<Connector>Mcp` function — see `connector-spawns.ts` and
 * `phase3-config.ts`.
 *
 * **Hostname conventions:**
 *
 * - Empty `network: []` ⇒ the connector has zero network reach (Linux
 *   `--unshare-net`, macOS sandbox-exec policy denies all network,
 *   Windows AppContainer with no `internetClient` cap).
 * - Each listed host is matched as an RFC 1123 hostname — no wildcards
 *   in object form per `permissions-validator.ts`.
 * - For services whose hostnames are user-configurable (self-hosted
 *   GitLab, Jira, Confluence, Bitbucket Server, Jenkins, Sentry,
 *   Grafana, Kubernetes API server), the row lists the SaaS default and
 *   leaves the user-host augmentation to Task 14 (the configured host
 *   will be read from vault / TOML and merged into the in-memory manifest
 *   at spawn time).
 *
 * **Filesystem permissions:**
 *
 * - Empty `filesystem.read` / `filesystem.write` ⇒ the connector sees only
 *   its cwd + a scoped temp dir (always-on per sandbox runner).
 * - The Obsidian connector needs read access to user vault paths; those
 *   are supplied at runtime via `[[filesystem.roots]]` and threaded into
 *   the manifest at spawn time (NOT baked into the registry here).
 * - The `filesystem` connector (built-in MCP-filesystem) gets read access
 *   to `paths.dataDir` — also threaded at spawn time, not baked here.
 *
 * The exhaustive Task 14 manifest sweep will replace this file's data.
 */
import type { ExtensionManifest } from "../../extensions/manifest.ts";

const DEFAULT_DENY: ExtensionManifest["permissions"] = {
  network: [],
  filesystem: { read: [], write: [] },
};

function baseManifest(
  id: string,
  permissions: ExtensionManifest["permissions"],
): ExtensionManifest {
  return {
    id,
    version: "1.0.0",
    permissions,
  };
}

/**
 * Map of `serviceId` (the lazy-mesh `servers` key — `github`, `slack`,
 * `aws`, etc.) → resolved manifest. The keys MUST match the strings used
 * as `servers` keys in `lazy-mesh/` so `manifestForFirstParty(serviceId)`
 * returns the right row.
 *
 * Hostnames are conservative SaaS defaults. Self-hosted instances are
 * not yet covered — Task 14 will read configured hosts from vault/TOML
 * and extend the network list at spawn time.
 */
export const FIRST_PARTY_MANIFESTS: Record<string, ExtensionManifest> = {
  // Built-in MCP-filesystem child (eager). Reads under `paths.dataDir`
  // are threaded at spawn time (the dataDir is not stable across users).
  filesystem: baseManifest("com.nimbus.filesystem", DEFAULT_DENY),

  // --- Source-control + code review ---
  github: baseManifest("com.nimbus.github", {
    network: ["api.github.com", "uploads.github.com", "raw.githubusercontent.com"],
    filesystem: { read: [], write: [] },
  }),
  github_actions: baseManifest("com.nimbus.github-actions", {
    network: ["api.github.com"],
    filesystem: { read: [], write: [] },
  }),
  gitlab: baseManifest("com.nimbus.gitlab", {
    network: ["gitlab.com"],
    filesystem: { read: [], write: [] },
  }),
  bitbucket: baseManifest("com.nimbus.bitbucket", {
    network: ["api.bitbucket.org", "bitbucket.org"],
    filesystem: { read: [], write: [] },
  }),

  // --- Chat / collaboration ---
  slack: baseManifest("com.nimbus.slack", {
    network: ["slack.com", "api.slack.com", "wss-primary.slack.com", "wss-backup.slack.com"],
    filesystem: { read: [], write: [] },
  }),
  discord: baseManifest("com.nimbus.discord", {
    network: ["discord.com", "gateway.discord.gg", "cdn.discordapp.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- Issue tracking + docs ---
  linear: baseManifest("com.nimbus.linear", {
    network: ["api.linear.app"],
    filesystem: { read: [], write: [] },
  }),
  jira: baseManifest("com.nimbus.jira", {
    // SaaS default; self-hosted Jira hosts will be added by Task 14
    // via the `jira.base_url` vault entry. PR 1 ships SaaS only.
    network: ["api.atlassian.com"],
    filesystem: { read: [], write: [] },
  }),
  notion: baseManifest("com.nimbus.notion", {
    network: ["api.notion.com"],
    filesystem: { read: [], write: [] },
  }),
  confluence: baseManifest("com.nimbus.confluence", {
    // Same SaaS-only caveat as Jira.
    network: ["api.atlassian.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- Google bundle (Drive / Gmail / Photos) ---
  google_drive: baseManifest("com.nimbus.google-drive", {
    network: ["www.googleapis.com", "oauth2.googleapis.com", "accounts.google.com"],
    filesystem: { read: [], write: [] },
  }),
  gmail: baseManifest("com.nimbus.gmail", {
    network: ["www.googleapis.com", "gmail.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  google_photos: baseManifest("com.nimbus.google-photos", {
    network: ["www.googleapis.com", "photoslibrary.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- Microsoft bundle (OneDrive / Outlook / Teams) ---
  onedrive: baseManifest("com.nimbus.onedrive", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  outlook: baseManifest("com.nimbus.outlook", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  teams: baseManifest("com.nimbus.teams", {
    network: ["graph.microsoft.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- CI / CD / incident management ---
  jenkins: baseManifest("com.nimbus.jenkins", {
    // Jenkins is always self-hosted; the base URL comes from vault
    // (`jenkins.base_url`). The static row is empty because every Jenkins
    // user contacts a different host — `ensureJenkinsMcp` extends the
    // manifest's `network` list at spawn time with the hostname parsed
    // from `JENKINS_BASE_URL` (see `connector-spawns.ts`). Without that
    // runtime merge Jenkins would be unreachable under the sandbox; with
    // it, the connector talks only to the user-configured server.
    network: [],
    filesystem: { read: [], write: [] },
  }),
  circleci: baseManifest("com.nimbus.circleci", {
    network: ["circleci.com", "api.circleci.com"],
    filesystem: { read: [], write: [] },
  }),
  pagerduty: baseManifest("com.nimbus.pagerduty", {
    network: ["api.pagerduty.com", "events.pagerduty.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- Cloud platforms (Phase 3 bundle) ---
  //
  // AWS / Azure / GCP each spawn the vendor CLI as a subprocess; the CLI
  // does the real network I/O. The hostname surface is regional (S3 has
  // per-bucket hosts; EC2 has per-region endpoints; etc.) and the
  // validator at `permissions-validator.ts` rejects wildcards, so PR 1
  // lists the region-agnostic control-plane hosts only. Customers using
  // non-default regions or per-bucket S3 hosts will see auth/list calls
  // succeed but data-plane calls fail under the sandbox — that is the
  // known PR 1 limitation tracked as a Task 14 follow-up.
  aws: baseManifest("com.nimbus.aws", {
    // Region-agnostic AWS control-plane hosts: STS, IAM, S3 global,
    // CloudFront / ACM (us-east-1-only services), plus the us-east-1
    // service endpoints most users hit by default. Other regions add
    // hosts via TOML config (Task 14 follow-up: structured region matrix).
    network: [
      "sts.amazonaws.com",
      "iam.amazonaws.com",
      "s3.amazonaws.com",
      "ec2.amazonaws.com",
      "cloudfront.amazonaws.com",
    ],
    filesystem: { read: [], write: [] },
  }),
  azure: baseManifest("com.nimbus.azure", {
    // Azure Resource Manager control plane + AAD OAuth endpoint. Data-
    // plane hosts (`<account>.blob.core.windows.net`, region-specific
    // service endpoints) are not enumerated — those are deferred to a
    // Task 14 follow-up so we don't ship a wrong over-broad list.
    network: ["management.azure.com", "login.microsoftonline.com"],
    filesystem: { read: [], write: [] },
  }),
  gcp: baseManifest("com.nimbus.gcp", {
    // GCP IAM control plane + OAuth token endpoint. Service-specific
    // hostnames (e.g. `storage.googleapis.com`, `bigquery.googleapis.com`)
    // are intentionally not in the base list — Task 14 follow-up will
    // enumerate them once we have a coverage report from the CLI surface.
    network: ["cloudresourcemanager.googleapis.com", "oauth2.googleapis.com"],
    filesystem: { read: [], write: [] },
  }),
  // IaC connector spawns terraform / pulumi / opentofu as subprocesses.
  // The connector itself opens no sockets; the CLI's network needs are
  // governed by *its own* outbound traffic which sits outside the
  // sandbox boundary (the CLI is exec'd inside the sandboxed connector
  // but its network calls go through whatever the sandbox grants).
  // Filesystem permissions are intentionally empty here too — IaC tool
  // calls take a per-call `workingDirectory` argument, so the relevant
  // scope is set by the sandbox cwd at spawn time, not baked into the
  // static manifest.
  iac: baseManifest("com.nimbus.iac", DEFAULT_DENY),

  // --- Observability ---
  grafana: baseManifest("com.nimbus.grafana", {
    // Grafana is always user-configured (could be SaaS `*.grafana.net`
    // or any self-hosted host). The static row is empty;
    // `phase3AddGrafanaMcp` extends `network` with the hostname parsed
    // from `GRAFANA_URL` at spawn time.
    network: [],
    filesystem: { read: [], write: [] },
  }),
  sentry: baseManifest("com.nimbus.sentry", {
    // SaaS default. Self-hosted Sentry users set `sentry.url`; runtime
    // merge to extend with that host is a known Task 14 follow-up.
    network: ["sentry.io"],
    filesystem: { read: [], write: [] },
  }),
  newrelic: baseManifest("com.nimbus.newrelic", {
    network: ["api.newrelic.com", "api.eu.newrelic.com"],
    filesystem: { read: [], write: [] },
  }),
  datadog: baseManifest("com.nimbus.datadog", {
    // Datadog regional endpoints (us1/us3/us5/eu1/ap1/gov) are selected
    // via `DD_SITE`. The default is us1 (`api.datadoghq.com`). Users on
    // other sites lose network until the Task 14 runtime-merge follow-up
    // reads `DD_SITE` and substitutes `api.${DD_SITE}`.
    network: ["api.datadoghq.com"],
    filesystem: { read: [], write: [] },
  }),

  // --- Cluster management ---
  kubernetes: baseManifest("com.nimbus.kubernetes", {
    // Kubernetes API server hostname lives inside the kubeconfig YAML
    // file. Parsing kubeconfig at spawn time to extract `clusters[*]
    // .cluster.server` is a Task 14 follow-up — for PR 1 the connector
    // is reachable only when the user's outbound network policy already
    // allows the API server (e.g. on-cluster service account workflows
    // where the kubeconfig server is a non-routable IP). General use is
    // tracked as a known PR 1 limitation.
    network: [],
    filesystem: { read: [], write: [] },
  }),

  // --- Local-only ---
  obsidian: baseManifest("com.nimbus.obsidian", {
    // No network. Vault paths are filesystem-only and supplied at spawn
    // time via `[[filesystem.roots]]`, threaded into the manifest by
    // `connector-spawns.ts::ensureObsidianMcp` before `wrapServerSpec`.
    // Static row is empty because vault paths are user-scoped (not stable
    // across users / installs).
    network: [],
    filesystem: { read: [], write: [] },
  }),
};

/**
 * Return the manifest for a first-party connector by service id. Unknown
 * service ids fall back to default-deny under `com.nimbus.<serviceId>`
 * — this ensures the I15 wiring never crashes the gateway if a new
 * lazy-mesh service id is added before its row exists here.
 */
export function manifestForFirstParty(serviceId: string): ExtensionManifest {
  const known = FIRST_PARTY_MANIFESTS[serviceId];
  if (known !== undefined) return known;
  return baseManifest(`com.nimbus.${serviceId}`, DEFAULT_DENY);
}

/**
 * Extract the bare hostname from a URL string. Returns `null` if the
 * input is not parseable or its hostname is empty. Used by connector
 * spawn helpers (`ensureJenkinsMcp`, `phase3AddGrafanaMcp`) to derive
 * the runtime `permissions.network` entry from user-configured base
 * URLs. Lowercases the result so the hostname matches the sandbox
 * runner's case-insensitive comparison.
 */
export function hostnameFromUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const host = url.hostname.toLowerCase();
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Return a clone of the first-party manifest for `serviceId` with
 * `extraNetworkHosts` appended to `permissions.network`. Duplicates and
 * malformed entries are silently dropped. Used by connector spawn
 * helpers that need to extend the static-registry network list with a
 * user-configured hostname (`jenkins.base_url`, `grafana.url`, …).
 *
 * The static manifest object itself is never mutated — callers receive a
 * fresh manifest reference, mirroring the pattern in
 * `ensureObsidianMcp` (which extends `filesystem.read`).
 */
export function manifestWithExtraNetworkHosts(
  serviceId: string,
  extraNetworkHosts: readonly string[],
): ExtensionManifest {
  const base = manifestForFirstParty(serviceId);
  if (extraNetworkHosts.length === 0) return base;
  const existing = new Set(base.permissions.network);
  const merged = [...base.permissions.network];
  for (const host of extraNetworkHosts) {
    const lower = host.toLowerCase().trim();
    if (lower === "" || existing.has(lower)) continue;
    existing.add(lower);
    merged.push(lower);
  }
  return {
    ...base,
    permissions: {
      network: merged,
      filesystem: {
        read: [...base.permissions.filesystem.read],
        write: [...base.permissions.filesystem.write],
      },
    },
  };
}

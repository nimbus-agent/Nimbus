export function printConnectorHelp(): void {
  console.log(`nimbus connector — cloud connector registration and sync (Q2)

Usage:
  nimbus connector auth <service> [--port <n>] [--scopes a,b] [--token <pat>] [--api-base <url>] [--help]
  nimbus connector detect [--json] [--source gh|aws|kubectl|gcloud] [--replace] [--project <id>]   Reuse gh/aws/kubectl/gcloud logins you already have
  nimbus connector add --mcp <mcp_id> [--read <path>]... [--net <host[:port]>]... [--model] -- <command> [args...]
      Register a user MCP server (id must be mcp_*). --read/--net grant filesystem/network access;
      --model: offer this server's tools to the model in nimbus ask; each call still asks for approval.
      Example: nimbus connector add --mcp mcp_echo -- /abs/path/echo/dist/echo
  nimbus connector tools <mcp_id> [--json]                         List a user MCP server's tools
  nimbus connector call <mcp_id> <tool> [--input <json>] [--json]   Call one (asks for approval)
  nimbus connector list [--json]
  nimbus connector history <service> [--limit N]
  nimbus connector status <service> [--stats]
  nimbus connector sync <service> [--full | --force]
  nimbus connector pause <service>
  nimbus connector resume <service>
  nimbus connector set-interval <service> <duration>
  nimbus connector migrate list [--json]             Built-in connectors moving to a signed extension
  nimbus connector migrate accept <id>               Keep it: one approval at a terminal (no --yes)
  nimbus connector migrate decline <id>              Keep it off; items are kept
  nimbus connector migrate retry [--json]            Prepare failed and declined migrations again
  nimbus connector writes enable <service> [--wave 2|3|4]   Let the model propose this service's writes (asks you; each call still asks)
  nimbus connector writes enable <service> --door agent [--wave 2|3|4] [--approve <tool-id|prefix*>]
                                                Approve writes for outside agents (a person at a terminal only)
  nimbus connector writes enable mcp_<id> --door agent [--approve <tool> ...]
                                                Approve a user MCP server's tools for outside agents, by exact name
                                                (with no --approve: list the tools and their hashes, ask nothing)
  nimbus connector writes disable <service> [--door agent]
  nimbus connector writes status [--json]
  nimbus connector remove <service> [--yes]         Irreversible; prompts unless --yes

Services (examples): google_drive, gmail, google_photos, onedrive, outlook, teams, github, gitlab, linear, jira, notion, confluence, jenkins, circleci, pagerduty, kubernetes

OAuth PKCE — set env vars before nimbus start, or run for setup steps:
  nimbus connector auth google_drive --help    (gmail, google_photos, google_calendar)
  nimbus connector auth onedrive --help        (outlook, teams)
  nimbus connector auth slack --help
  nimbus connector auth notion --help

Env vars: NIMBUS_OAUTH_GOOGLE_CLIENT_ID, NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET (Web OAuth clients only), NIMBUS_OAUTH_MICROSOFT_CLIENT_ID, NIMBUS_OAUTH_SLACK_CLIENT_ID,
  NIMBUS_OAUTH_NOTION_CLIENT_ID, NIMBUS_OAUTH_NOTION_CLIENT_SECRET
`);
  console.log(`GitHub: use --token or env NIMBUS_GITHUB_PAT (stored as vault key github.pat). Also registers GitHub Actions sync (service id github_actions) with the same PAT.
GitHub Enterprise Server: add --api-base https://ghe.example.com (stored as github.api_base; https only, one instance at a time, GHE.com is not supported). Re-running without --api-base returns to github.com.
GitLab: use --token or env NIMBUS_GITLAB_PAT (gitlab.pat). Self-hosted: --api-base https://git.example.com/api/v4 (gitlab.api_base).
Linear: use --token or env NIMBUS_LINEAR_API_KEY (linear.api_key).
`);
  console.log(`Jira: use --username (Atlassian email), --token (API token), --api-base https://your-domain.atlassian.net
  or env NIMBUS_JIRA_EMAIL, NIMBUS_JIRA_API_TOKEN, NIMBUS_JIRA_BASE_URL (jira.email, jira.api_token, jira.base_url).
  --cloud-id <uuid> (or env NIMBUS_JIRA_CLOUD_ID; vault key jira.cloud_id): your Atlassian cloud id, needed by the Jira Service Management alert tools
  (acknowledge and close). Optional on a *.atlassian.net site (found by asking https://<site>.atlassian.net/_edge/tenant_info, which also shows it);
  REQUIRED for a Data Center or proxied site. Leaving the flag off keeps a stored id while the site URL is unchanged; it is cleared when the site changes, or by "nimbus connector remove jira".
Notion: OAuth in the browser (notion.oauth); see auth notion --help for env setup.
Confluence: same flags/env pattern as Jira (NIMBUS_CONFLUENCE_* → confluence.email, confluence.api_token, confluence.base_url).
`);
  console.log(`Jenkins: --username, --token (API token), --api-base https://ci.example/  or env NIMBUS_JENKINS_USERNAME, NIMBUS_JENKINS_API_TOKEN, NIMBUS_JENKINS_BASE_URL (jenkins.username, jenkins.api_token, jenkins.base_url).
CircleCI: --token (personal API token) or env NIMBUS_CIRCLECI_API_TOKEN / CIRCLECI_TOKEN (vault key circleci.api_token). Indexes pipelines for GitHub repos already in the local index (project slug gh/owner/repo).
`);
  const pdEnv = "NIMBUS_PAGERDUTY_API_TOKEN";
  const pdAlt = "PAGERDUTY_API_TOKEN";
  console.log(
    `PagerDuty: --token (REST API token) or env ${pdEnv} / ${pdAlt} (vault key pagerduty.api_token). Indexes open incidents for search.
  --username <email> (or env NIMBUS_PAGERDUTY_FROM_EMAIL; vault key pagerduty.from_email): the e-mail of a valid PagerDuty user. PagerDuty requires it as the From header on every incident write (acknowledge, resolve, escalate); without it incidents are read and indexed but those writes are not offered to the model.`,
  );
  console.log(`Kubernetes: --kubeconfig <path> [--context <name>] or env NIMBUS_KUBECONFIG / KUBECONFIG (vault keys kubernetes.kubeconfig, optional kubernetes.context). Indexes cluster deployments.

Most other token / API-key connectors (stripe, vercel, snowflake, elasticsearch, …) have no auth flow:
store their settings with \`nimbus vault set <service>.<key>\`, which prompts for the value (each write asks for approval).
\`nimbus connector auth <service>\` prints the exact keys for one of them.

Credentials are stored in the OS vault only (never printed here).
`);
}

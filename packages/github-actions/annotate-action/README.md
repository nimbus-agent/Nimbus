# nimbus-agent/annotate-action

First-party GitHub Action that records a deployment in the local Nimbus index by POSTing to the Gateway's write surface at `POST /v1/deployments`. The annotation becomes the authoritative source for the **deploy-frequency** DORA metric and links the workflow run to the service / environment / SHA tuple.

## Getting started

The annotation surface is **opt-in and gated by a bearer token** stored in the Nimbus Vault. Set it up once on the runner:

1. **Mint a token** on the self-hosted runner where the Gateway is running:

   ```bash
   openssl rand -hex 32                         # copy the output
   nimbus vault set http_api.deployment_token   # paste it at the hidden prompt
   ```

   Read it back so you can copy it into GitHub Repository Secrets:

   ```bash
   nimbus vault get http_api.deployment_token
   ```

   The Gateway picks the new key up immediately — no restart needed.

2. **Store the token as a GitHub Repository Secret.** In the repo settings: *Settings → Secrets and variables → Actions → New repository secret*. Name it `NIMBUS_DEPLOYMENT_TOKEN` (or any name you prefer; reference it consistently in workflows).

3. **Wire the Action into your deploy workflow.** Place it after the actual deploy step so `status` reflects the outcome:

   ```yaml
   - name: Record deployment in Nimbus
     if: always()
     uses: nimbus-agent/annotate-action@v0.1.0
     with:
       service: payment-service
       environment: prod
       status: ${{ job.status }}
       token: ${{ secrets.NIMBUS_DEPLOYMENT_TOKEN }}
   ```

   `${{ job.status }}` resolves to `success`, `failure`, or `cancelled`, which is exactly the shape `status` expects.

## Requirements

- **Self-hosted runner with the Nimbus Gateway running locally** (`http://localhost:7474` by default). Hosted runners (`ubuntu-latest`) are not supported in v0.1.0 — the Gateway is local-only.
- A `[metrics.dora.<service-id>]` (or `[ci.service.<service-id>]`) block in `nimbus.toml` mapping the service id to its repos.
- A `[deploy.environments]` entry containing the environment name being annotated.
- `http_api.deployment_token` set in the Vault (see "Getting started" above).

## Inputs

| Input | Required | Default | Notes |
|---|---|---|---|
| `service` | yes | — | Nimbus service id. Must match a configured `[metrics.dora.<id>]` or `[ci.service.<id>]` block. |
| `environment` | yes | — | Deployment environment name. Must match an entry under `[deploy.environments]`. |
| `status` | yes | — | One of `success`, `failure`, `cancelled`, `in_progress`. |
| `token` | yes (secret) | — | Bearer token matching the Vault key `http_api.deployment_token`. Pass via GitHub Repository Secrets. |
| `sha` | no | `${{ github.sha }}` | Git SHA being deployed. |
| `target-ref` | no | `${{ github.ref }}` | Git ref being deployed. |
| `workflow-url` | no | `""` | Direct link to the workflow run. |
| `run-id` | no | `""` | CI run id. |
| `job-id` | no | `""` | CI job id within the run. |
| `started-at` | no | `Date.now()` at Action runtime | Unix-ms timestamp when the deploy started. |
| `finished-at` | no | `""` | Unix-ms timestamp when the deploy finished. Omit while still in progress. |
| `gateway-url` | no | `http://localhost:7474` | Base URL of the Gateway. |
| `timeout-ms` | no | `10000` | HTTP timeout. |
| `allow-gateway-failure` | no | `false` | When `true`, any Gateway-side failure (unreachable, 401, 429, 503) is logged as a warning but never fails the workflow. |

## Outputs

| Output | Notes |
|---|---|
| `external-id` | Canonical external id minted by the Gateway, e.g. `github-actions:run-12345:job-67890`. |
| `is-new` | `"true"` if this annotation created a new row, `"false"` if it updated an existing one. |
| `dora-eligible` | `"true"` if the deploy is counted in the DORA deploy-frequency calculation. |

## Exit codes

| Gateway response | `allow-gateway-failure=false` (default) | `allow-gateway-failure=true` |
|---|---|---|
| `200 OK` | `0` | `0` |
| `401 unauthorized` | `1` | `0` |
| `429 rate_limited` | `1` | `0` |
| `503 write_surface_disabled` | `1` | `0` |
| Network unreachable / 4xx / 5xx | `1` | `0` |

When the Gateway returns `503 write_surface_disabled`, its `hint` field is surfaced **verbatim** in a `::warning::` annotation so operators can copy-paste the `nimbus vault set http_api.deployment_token …` instruction directly from the workflow log.

## Versioning

This release uses **fully-pinned tags** (`v0.1.0`, `v0.1.1`, …). Users should reference specific versions while the Action is in v0.x:

```yaml
uses: nimbus-agent/annotate-action@v0.1.0
```

A `v0` major-version moving tag is **intentionally not provided yet** — the Action's input contract may still evolve before v1.0.0.

## Building from source

Source lives in the Nimbus monorepo at `packages/github-actions/annotate-action/`. Build with:

```bash
cd packages/github-actions/annotate-action
bun run build
```

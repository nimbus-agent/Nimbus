# Flux Connector

## What this is

First-party Nimbus MCP connector for [Flux](https://fluxcd.io/) (the GitOps
Toolkit). Reads Flux **Custom Resources** directly from the Kubernetes API
server and indexes them as a single `flux:resource` item type (with a `kind`
discriminator in metadata) in the local index, exposing three read-only tools
to the Nimbus agent (`flux_list`, `flux_get`, `flux_search`). Useful for
deployment correlation — "did this Kustomization / HelmRelease go
NotReady when the alert fired?" — and complements the ArgoCD connector for
teams mixing both.

v1 indexes nine GitOps-Toolkit kinds: Kustomizations, HelmReleases, the
sources (GitRepository / OCIRepository / HelmRepository / Bucket), and the
image-automation objects (ImageRepository / ImagePolicy /
ImageUpdateAutomation). The `flux reconcile` / `flux suspend` write tools are
deferred to Phase 6.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Flux is always self-hosted: both keys are required (no defaults).
# flux.api_url is the Kubernetes API server base (or a TLS-terminating proxy).
nimbus vault set flux.api_url https://k8s.example.com:6443
nimbus vault set flux.token <your-read-only-serviceaccount-jwt>

nimbus ask "Which Flux Kustomizations are NotReady right now?"
```

The token is a **read-only Kubernetes ServiceAccount JWT** that must have
cluster read (`get` / `list`) RBAC on the Flux CRD groups
(`kustomize.toolkit.fluxcd.io`, `helm.toolkit.fluxcd.io`,
`source.toolkit.fluxcd.io`, `image.toolkit.fluxcd.io`). The Gateway injects
`flux.api_url` as `FLUX_API_URL` and `flux.token` as `FLUX_TOKEN` at spawn
time; the connector itself never touches the vault. The token is sent as the
`Authorization: Bearer <token>` header.

Because Flux has no central API and no SaaS host, the sandbox network list is
empty in the static manifest — the gateway parses the hostname from
`flux.api_url` and extends the sandbox network allow-list at spawn time
(`phase3AddFluxMcp`, same pattern as Grafana / ArgoCD).

**TLS caveat.** Kubernetes API servers commonly present self-signed
certificates that Bun's `fetch` rejects. v1 relies on `flux.api_url` pointing
at an endpoint with a CA-trusted certificate — e.g. an ingress with valid TLS
or a local `kubectl proxy`. Custom-CA / insecure-TLS handling is a deferred
follow-up.

The gateway-side syncable
(`packages/gateway/src/connectors/flux-sync.ts`) walks the nine CRD kinds,
issuing one all-namespaces `GET /apis/<group>/<version>/<plural>` per kind, and
upserts each resource with `external_id = <kind>/<namespace>/<name>` and
metadata `{ kind, name, namespace, ready_status, ready_reason, ready_message,
suspend, url, path, last_applied_revision, last_attempted_revision, created_at,
canonical_url }`. A CRD group that is not installed on the cluster (4xx/5xx on
that endpoint) is non-fatal — the other kinds still index.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `flux.api_url` | yes | Kubernetes API server base (e.g. `https://k8s.example.com:6443`); requests go to `${api_url}/apis/...`. Must be CA-trusted (TLS caveat above). |
| `flux.token` | yes | Read-only Kubernetes ServiceAccount JWT (sent as `Authorization: Bearer <token>`). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `flux_list` | List resources of one `kind` (default `kustomization`); optional `namespace` + `limit`. |
| `flux_get` | Fetch one resource by `kind`, `namespace`, `name`. |
| `flux_search` | Substring search across resources of one `kind` (name, namespace, Ready reason/message). |

All three tools are read-only; `hitlRequired` is intentionally empty. The
`flux reconcile` / `flux suspend` write tools are deferred to Phase 6.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

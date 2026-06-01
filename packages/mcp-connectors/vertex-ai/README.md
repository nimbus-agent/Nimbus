# GCP Vertex AI Connector

## What this is

Nimbus MCP connector for GCP Vertex AI. This is a **Tier-3 "no-row-data"**
connector: it indexes Vertex AI model **REGISTRY metadata only** — the model
resource name, display name, version id, region, and create/update
timestamps. It **never** runs inference or fetches model outputs into the local
index. There is no `gcloud ai endpoints predict`, no `explain`, no
`raw-predict`, and no batch-prediction output read — those are forbidden by
design, and the `assertNoRowDataTools` contract test locks the metadata-only
surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Vertex AI reuses your existing GCP credentials — no separate Vertex AI secret.
Configure the GCP connector (service-account JSON key path + project id), which
Vertex AI reads via the gcloud CLI:

```bash
nimbus connector auth gcp
nimbus ask "Which Vertex AI models were updated this month?"
```

### Optional configuration

Vertex AI is regional. The connector reads an **optional** `gcp.region` vault
key (e.g. `europe-west4`); when absent it defaults to `us-central1`:

```bash
nimbus vault set gcp.region europe-west4
```

## Tools

- `vertex_ai_list` — list models in a region (metadata only).
- `vertex_ai_get` — one model's registry metadata (`describe`).
- `vertex_ai_search` — substring search over model display + resource names.

## See also

- [Vertex AI Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

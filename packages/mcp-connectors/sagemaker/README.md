# Amazon SageMaker Connector

## What this is

Nimbus MCP connector for Amazon SageMaker. This is a **Tier-3
"no-row-data"** connector: it indexes ML-model **registry metadata only** —
model name, ARN, primary-container image reference, model-data S3 URL (a pointer
string, not the bytes), execution-role ARN, and creation time. It **never**
invokes an endpoint and **never** fetches inference data, training data, or
model-artifact bytes into the local index. There is no
`sagemaker-runtime invoke-endpoint`, no predict, no query, and no records path —
those are forbidden by design, and the `assertNoRowDataTools` contract test
locks the metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

SageMaker reuses your existing AWS credentials — no separate SageMaker secret.
Configure the AWS connector (access key + secret + region, or a named profile),
which SageMaker reads via the aws CLI:

```bash
nimbus connector auth aws
nimbus ask "Which SageMaker models were created most recently?"
```

## Tools

- `sagemaker_list` — list models (metadata only; optional name substring).
- `sagemaker_get` — one model's describe metadata (container image, model-data S3 pointer, execution role).
- `sagemaker_search` — substring search over model names.

## See also

- [SageMaker Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

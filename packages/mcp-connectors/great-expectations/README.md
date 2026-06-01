# Great Expectations Connector

## What this is

Nimbus MCP connector for [Great Expectations](https://greatexpectations.io/).
This is a **Tier-3 "no-row-data"** connector with a difference: it has **no
network and no live credentials**. Great Expectations validation results are CI
**artefacts** — JSON files written by GX runs. This connector reads those JSON
artefacts from a configured local directory and indexes the validation
**metadata** per expectation: suite name, batch id, expectation type, column,
success/failure, the aggregate observed value (a count/fraction/mean — a metric,
not data rows), and element/unexpected counts.

It **never** reads or indexes the failing-data **samples** — `unexpected_list`,
`partial_unexpected_list`, `partial_unexpected_index_list`,
`unexpected_index_list`, `partial_unexpected_counts`. Those carry real data cell
values (row data) and are stripped on read. The `assertNoRowDataTools` contract
test locks the metadata-only tool surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Point the connector at the directory holding your GX validation-result JSON
artefacts (e.g. a CI-published `great_expectations/uncommitted/validations/`
tree, or a flat artefacts dir). This is a non-secret **path**, not a credential:

```bash
nimbus vault set great_expectations.results_dir /path/to/great_expectations/uncommitted/validations
nimbus ask "Which data-quality expectations failed in the latest run?"
```

## Tools

- `great_expectations_list` — recent validation results (metadata only).
- `great_expectations_get` — one validation result by external id.
- `great_expectations_search` — substring search over suite/expectation names.

## See also

- [Great Expectations Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

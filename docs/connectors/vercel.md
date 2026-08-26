# Vercel connector — quirks

Migrated from inline comments in `packages/gateway/src/connectors/vercel-*.ts` and the `vercel` connector in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers).

## Entries

### `created` field is epoch milliseconds, not seconds

**Source:** `packages/gateway/src/connectors/vercel-deployment-mapping.ts:9` — added 2026-05-28
**Original comment (excerpt):** `IMPORTANT: Vercel's created is epoch MILLISECONDS (a number) — pass through verbatim via numberField, NO Date.parse.`

Vercel's `GET /v6/deployments` list response returns the `created` field as a raw epoch-millisecond number, not an ISO 8601 string and not epoch seconds. The mapper uses `numberField` directly without passing the value through `Date.parse`. Applying `Date.parse` would interpret the millisecond integer as a string (yielding `NaN`) or produce a timestamp many centuries in the future. The item type (`vercel:deployment`) is intentionally sparse/structured and therefore routed to the local MiniLM embedder rather than `PROSE_HEAVY_TYPES`.

---

### `deployment` type column is shared with the CI/CD annotation pipeline but keys differ

**Source:** `packages/gateway/src/connectors/vercel-deployment-mapping.ts:9` — added 2026-05-28
**Original comment (excerpt):** `NOTE: the bare deployment column value is shared with the CI/CD annotation pipeline, but that pipeline keys its rows under the CI-provider service (github-actions etc.), so the (service, external_id) unique key never collides with this connector's service = "vercel" rows.`

Both the Vercel connector and the post-deploy annotation pipeline write rows with `type = "deployment"` into the unified index. Collision is prevented by the `(service, external_id)` composite unique key: Vercel rows carry `service = "vercel"` while CI/CD annotation rows carry the CI provider name (`github-actions`, `gitlab`, etc.). The two namespaces are disjoint and no upsert can accidentally overwrite the other's rows.

---
name: nimbus-connector-authoring
description: >
  Complete reference for authoring first-party MCP connectors: package layout,
  tool surface, manifest structure, credential injection, the sync handler contract, item
  ID format, consent and gateway write gating, contract tests, and coverage gates. Use when creating or
  modifying a connector, deciding which tools to expose (incl. write tools), debugging a
  contract-test failure, wiring an MCP server into the registry, or asking how credentials
  reach the connector process / what a sync handler returns. Consult before writing any
  connector code.
---

# Nimbus Connector Authoring

## Package Location

First-party connectors live in their OWN repository, [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers), at `connectors/<name>/`, and ship as
the `@nimbus-dev/connectors` npm package. They are no longer workspace packages of this repo — the
real dependency set is declared once in that repository's root manifest. Each connector has:

- `package.json`
- `src/server.ts` entry point
- `nimbus.extension.json` manifest

## Tool Surface

There is no mandatory `list`/`get`/`search` triple. A connector exposes the tools its service needs; `collection-tool-kit.ts` in nimbus-mcp-servers offers that triple as a convenience, not a requirement. The connector half (tool surface, consent, kits, contract tests) is documented in nimbus-mcp-servers' [guide to adding a connector](https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md); follow it for everything under `connectors/<id>/`.

Every mutating tool registers through `createWriteToolRegistrar` in that repository's `shared/consent-kit.ts`, never the raw MCP registration call. The consent gate lives in the registrar, not in a prompt.

## Manifest Structure

`nimbus.extension.json` must include:

| Field | Format | Notes |
|---|---|---|
| `id` | reverse-domain (e.g. `com.nimbus.github`) | stable across versions |
| `displayName` | string | UI-facing |
| `version` | semver | bumps on every release |
| `entrypoint` | path | usually `dist/server.js` |
| `runtime` | `"bun"` | only supported runtime today |
| `permissions` | object — `{ network?: string[]; filesystem?: { read?: string[]; write?: string[] } }` | declares the sandbox surface (I15) |
| `hitlRequired` | string array | every write permission listed here |
| `syncInterval` | seconds | default sync cadence |
| `minNimbusVersion` | semver | gating |

The `hitlRequired` field is a manifest declaration of which write/delete permissions need consent (it must be an array; leave it empty if all tools are read-only). It is NOT what the gateway gates on: omitting an entry does not bypass the gateway's gate. Connector writes are gated by `HITL_REQUIRED_BACKING` (module-private in `packages/gateway/src/engine/executor.ts`) and by `CONNECTOR_WRITE_ROWS` (`packages/gateway/src/connectors/connector-writes/index.ts`); a write tool with no row is refused. See § Write tools on the gateway side.

### Sandbox declaration

The `permissions` object is the manifest contract that drives the per-OS sandbox runner (invariant `I15`). Declare only the hostnames and path prefixes your connector actually needs — the runner denies everything else to the depth each OS can (bwrap + a local per-host network forwarder on Linux (I50), sandbox-exec SBPL on macOS, AppContainer + `internetClient` capability on Windows). For the full schema, examples, platform asymmetry (macOS limits ports, not hosts; Windows is network-on-or-off until WFP support lands), and the pre-T2 reinstall flow for older extensions, see [`docs/sandbox.md`](../../docs/sandbox.md).

## Credential Injection Pattern

**Credentials are never fetched from the Vault inside the connector.** They arrive as environment variables injected at spawn time by the Gateway. The connector reads them from `process.env` at startup. **Never call any Vault API from connector code** — the connector process has no Vault access by design.

```typescript
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error("GITHUB_TOKEN not set");
```

## Sync Handler Contract

Implement `ConnectorSyncHandler`:

```typescript
interface ConnectorSyncHandler {
  connectorId: string;
  syncInterval: number;
  sync(db: Database, lastSyncToken: string | null): Promise<SyncResult>;
}

interface SyncResult {
  upserted: IndexedItem[];
  deleted: string[];
  nextSyncToken: string;
  hasMore?: boolean;
}
```

- `hasMore: true` causes the scheduler to re-queue immediately.
- Always return a `nextSyncToken` even on first sync — use a timestamp string if the API has no native token.

## Item ID Format

Always `"<service>:<native_id>"` — e.g. `"github:pr_12345"`.

**Never use a UUID.** IDs must be stable across syncs so upserts work correctly.

## HITL Tool Declaration

There is no `server.assertHitlRequired()`. A write tool gets its consent gate structurally, by registering through `createWriteToolRegistrar` in nimbus-mcp-servers' `shared/consent-kit.ts`. The gateway then classifies and gates it separately (see § Write tools on the gateway side).

## Contract Tests

Run `nimbus test` from the connector directory before submitting. This executes `runContractTests()` from `@nimbus-dev/sdk` which checks:

- Manifest schema validity.
- Item ID format on returned items.
- `SyncResult` shape.

**All must pass** before a PR is ready for review.

## Coverage Gate

The gateway-side half — the sync handler and its mapper under `packages/gateway/src/connectors/` — is held to this repository's per-file floor: **≥ 85% line + ≥ 80% branch coverage** (`audit:coverage-floor`; below-floor debt is tracked in `docs/structure-audit/coverage-baseline.json`). The MCP server half is measured in [nimbus-agent/nimbus-mcp-servers](https://github.com/nimbus-agent/nimbus-mcp-servers), not here: no connector source is in this repository's coverage. Integration tests use a fresh temp dir and real SQLite — no mocking the DB layer.

## Scaffold

No generator produces a first-party connector today. Write it by hand from nimbus-mcp-servers' [guide to adding a connector](https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md). Neither shortcut works there:

- `create-nimbus-connector`'s default target is still the pre-move `packages/mcp-connectors/<name>/` layout. Its `../../shared/*` imports and `extends: "../../../tsconfig.base.json"` do not resolve in nimbus-mcp-servers, even with `--out-dir connectors/<id>`, and it emits no `src/tools.ts`. Its `--standalone` output is for a connector outside that repository.
- `nimbus scaffold mcp` (alias `scaffold extension`) emits a standalone user MCP server, not a first-party connector, so its output is invisible to every connector gate.

Then do the gateway half below.

## Gateway half of a new connector

Adding a connector touches both repositories. The connector half is in nimbus-mcp-servers (see its [guide](https://github.com/nimbus-agent/nimbus-mcp-servers/blob/main/docs/adding-a-connector.md)). In this repository:

- The generated bundled registry: `packages/gateway/src/connectors/bundled-connector-registry.ts`, produced by `bun run gen:connector-registry` (`scripts/gen-bundled-connector-registry.ts`); do not hand-edit it.
- `packages/gateway/src/connectors/connector-catalog.ts`
- `packages/gateway/src/connectors/connector-secrets-manifest.ts`
- `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts`, and the enumerated list in `first-party-manifests.test.ts` beside it.
- Spawn wiring in `packages/gateway/src/connectors/lazy-mesh/`: add the connector to a `phase3-*.ts` group and to `phase3-config.ts`. Without it the gateway bundles the connector and never starts it.
- The docs page `packages/docs/src/content/docs/connectors/<id>.mdx`.
- Sync/indexing (a `ConnectorSyncHandler`) is an owner decision; raise it, do not build it unasked.

## Write tools on the gateway side

A connector write tool is never reachable by itself: the gateway classifies every connector write in ONE row table, `packages/gateway/src/connectors/connector-writes/` (`index.ts` `CONNECTOR_WRITE_ROWS`, with the generated `manifest.generated.ts`; `connector-write-registry.ts` consumes it). A write tool with no row is refused, every row prompts the owner (I26, I2), is ledgered before dispatch (I29) and is refused over federation. Whether the model or an outside MCP agent is ever offered it is a separate, owner-opt-in decision (I53, I58, `nimbus connector writes enable`), so adding a write tool to a connector does not offer it to any model. Read the `nimbus-mcp-sink` skill and `docs/SECURITY-INVARIANTS.md` I26/I53/I54 before adding a row; an installed connector update that changes a tool's listed definition suspends an agent-approved tool until the owner approves it again.

## Authoring Checklist

- [ ] Package created under `connectors/<name>/` in the connectors repo, by hand from its guide to adding a connector (see § Scaffold).
- [ ] `nimbus.extension.json` populated with `id`, `displayName`, `version`, `entrypoint`, `runtime: "bun"`, `permissions`, `hitlRequired`, `syncInterval`, `minNimbusVersion`.
- [ ] Every write tool registered through `createWriteToolRegistrar` (nimbus-mcp-servers `shared/consent-kit.ts`), and given a row in `CONNECTOR_WRITE_ROWS`.
- [ ] Credentials read from `process.env` only; no Vault API calls.
- [ ] If the owner decided the connector is indexed: `ConnectorSyncHandler` implemented; `SyncResult.nextSyncToken` always populated.
- [ ] Item IDs follow `"<service>:<native_id>"` — no UUIDs.
- [ ] `nimbus test` passes (contract tests green).
- [ ] Gateway half done (see § Gateway half of a new connector): catalog, secrets manifest, first-party manifests, spawn wiring, regenerated bundled registry, docs page.
- [ ] Line coverage ≥ 85% and branch coverage ≥ 80%.

## Signing your extension (T2 PR 2)

Every published extension SHOULD carry a `publisher` field + an embedded
Ed25519 `signature` field. Pre-T2 unsigned extensions still work but show
`(unverified)` in `nimbus extension list` and `nimbus extension info`.

**Generate a publisher keypair** (one-time):

```bash
nimbus extension keygen --out ~/.nimbus/publisher-key
```

`--out` writes the base64-encoded 32-byte Ed25519 seed to the given path
(mode `0600` on POSIX; best-effort on Windows). The matching public key is
printed to stdout — register this with the Nimbus registry (or with whoever
distributes your extension's public key).

**Add `publisher` to your manifest** (`nimbus.extension.json`):

```json
{
  "id": "com.example.my-extension",
  "version": "0.1.0",
  "permissions": { ... },
  "publisher": {
    "id": "my-publisher-id",
    "key": "<your base64 pubkey from keygen>"
  }
}
```

**Sign the manifest** before publishing:

```bash
nimbus extension sign ./path/to/my-extension --key ~/.nimbus/publisher-key
```

This writes the `signature` field back into the manifest in place. Re-run
after any manifest edit — the signature is over the canonicalized manifest
minus the signature field, so any other change invalidates the signature.

**Verification.** Both `nimbus extension install` and every Gateway startup
verify the signature against the publisher key (cached in vault under
`extension.publisher_key.<id>`). Verification failures refuse install or
hard-disable the extension at startup with a structured reason
(`publisher_key_missing`, `publisher_key_mismatch`, `signature_failed`, or
`signature_malformed`). See `docs/SECURITY-INVARIANTS.md` §I16.

A local install never fetches a key: ship the public key as a separate
file and install with `--publisher-key <path>` (or rely on a key the Vault
already caches for that publisher). A registry install takes the key from
the registry's signed index; a key that differs from the cached one is
refused (`ERR_REGISTRY_PUBLISHER_KEY_CONFLICT`) rather than replaced.

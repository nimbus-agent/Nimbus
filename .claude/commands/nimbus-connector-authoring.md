---
name: nimbus-connector-authoring
description: >
  Complete reference for authoring first-party MCP connectors: package layout, mandatory
  tool surface, manifest structure, credential injection, the sync handler contract, item
  ID format, HITL declaration, contract tests, and coverage gates. Use when creating or
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

## Mandatory Tool Surface

Every connector must expose **at minimum**:

- `list` (no HITL)
- `get` (no HITL)
- `search` (no HITL)

Write tools (`create`, `update`, `move`, `delete`) are conditional or always-HITL per the table in `docs/architecture.md`. **`move` and `delete` are always HITL.** Never omit a read tool to save time — the contract test will fail.

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

The `hitlRequired` field lists which write/delete permissions require Gateway HITL consent. This field is mandatory per the contract test (it must be an array). Populate it with the permission types (`"write"`, `"delete"`) that your connector's tools require; leave it empty if all tools are read-only. The Gateway gates actions based on the entries you list here — **if a write tool's permission is omitted from this array, the HITL gate is bypassed for that tool**.

### Sandbox declaration

The `permissions` object is the manifest contract that drives the per-OS sandbox runner (invariant `I15`). Declare only the hostnames and path prefixes your connector actually needs — the runner denies everything else (bwrap + per-host iptables on Linux, sandbox-exec SBPL on macOS, AppContainer + `internetClient` capability on Windows). For the full schema, examples, platform asymmetry (Windows is network-on-or-off until WFP support lands), and the pre-T2 reinstall flow for older extensions, see [`docs/sandbox.md`](../../docs/sandbox.md).

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

Write tools in the MCP server must call `server.assertHitlRequired()` at the **top of their handler**. The Gateway enforces HITL regardless, but the assertion makes intent explicit and the contract test checks for it.

## Contract Tests

Run `nimbus test` from the connector directory before submitting. This executes `runContractTests()` from `@nimbus-dev/sdk` which checks:

- Manifest schema validity.
- Mandatory tool surface presence (`list`, `get`, `search`).
- HITL declaration on write tools.
- Item ID format on returned items.
- `SyncResult` shape.

**All must pass** before a PR is ready for review.

## Coverage Gate

MCP connectors: **≥ 85% line + ≥ 80% branch coverage** (the per-file floor; tracked in `docs/structure-audit/coverage-baseline.json`). Integration tests use a fresh temp dir and real SQLite — no mocking the DB layer.

## Scaffold

Always start from:

```bash
nimbus scaffold extension connectors/<name>   # run from the connectors repo root
```

Then add the sync handler and register in the connector registry at `packages/gateway/src/connectors/registry.ts`.

## Authoring Checklist

- [ ] Package created under `connectors/<name>/` in the connectors repo via `nimbus scaffold extension`.
- [ ] `nimbus.extension.json` populated with `id`, `displayName`, `version`, `entrypoint`, `runtime: "bun"`, `permissions`, `hitlRequired`, `syncInterval`, `minNimbusVersion`.
- [ ] Mandatory `list`, `get`, `search` tools exposed.
- [ ] Every write tool listed in `hitlRequired` and calls `server.assertHitlRequired()` at the top of its handler.
- [ ] Credentials read from `process.env` only; no Vault API calls.
- [ ] `ConnectorSyncHandler` implemented; `SyncResult.nextSyncToken` always populated.
- [ ] Item IDs follow `"<service>:<native_id>"` — no UUIDs.
- [ ] `nimbus test` passes (contract tests green).
- [ ] Connector registered in `packages/gateway/src/connectors/registry.ts`.
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

For air-gap installs, ship the public key as a separate file and install
with `--publisher-key <path>`. To refresh keys for already-installed
extensions when the publisher rotates, run `nimbus extension sync`.

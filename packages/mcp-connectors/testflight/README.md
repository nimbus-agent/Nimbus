# TestFlight Connector

## What this is

First-party Nimbus MCP connector for [TestFlight](https://developer.apple.com/testflight/),
via Apple's [App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi).
Indexes the user's App Store Connect **apps** and recent TestFlight **builds**
into the local index as `testflight:app` and `testflight:build` items and
exposes three read-only tools to the Nimbus agent (`testflight_list`,
`testflight_get`, `testflight_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set testflight.issuer_id <your-issuer-id>
nimbus vault set testflight.key_id <your-key-id>
nimbus vault set testflight.private_key "$(cat AuthKey_XXXXXXXX.p8)"
nimbus ask "Which TestFlight builds are still PROCESSING?"
```

The three credentials come from App Store Connect → Users and Access → Integrations →
App Store Connect API: the **Issuer ID**, a generated **Key ID**, and the
matching **`.p8`** private key (EC P-256, downloadable once). The Gateway injects
them as `TESTFLIGHT_ISSUER_ID` / `TESTFLIGHT_KEY_ID` / `TESTFLIGHT_PRIVATE_KEY`
env at spawn time; the connector itself never touches the vault, and all three
must be set or the connector no-ops.

## Authentication

The App Store Connect API authenticates with a short-lived **ES256 JWT** bearer
token, minted fresh per request from the three credentials (header
`{ alg: ES256, kid, typ: JWT }`, claims `{ iss, iat, exp, aud: appstoreconnect-v1 }`,
`exp` ≤ 20 min). The token is signed with `node:crypto` using
`dsaEncoding: "ieee-p1363"` (raw `r||s`, as JWS requires) — no external JWT
dependency. The gateway-side syncable
(`packages/gateway/src/connectors/testflight-sync.ts`) walks
`GET /v1/apps → GET /v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=50`
and upserts each build with metadata
`{ app_id, version, processing_state, expired, uploaded_date, min_os_version,
uses_non_exempt_encryption }`.

Tools exposed:

| Tool                | Purpose                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| `testflight_list`   | List the user's apps, or recent builds for an app (limit optional).              |
| `testflight_get`    | Fetch a single build by id, or a single app by id.                               |
| `testflight_search` | Substring search across an app's recent builds (version / processing state / id). |

All three tools are read-only; `hitlRequired` is intentionally empty.
TestFlight write actions (expire a build, manage tester groups, submit beta
feedback) are deferred — the roadmap row scopes this connector to read-only
mobile beta-build observability.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

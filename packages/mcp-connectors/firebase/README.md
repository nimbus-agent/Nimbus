# Firebase App Distribution Connector

## What this is

First-party Nimbus MCP connector for
[Firebase App Distribution](https://firebase.google.com/docs/app-distribution),
via the [App Distribution REST API](https://firebase.google.com/docs/reference/app-distribution/rest).
Indexes each configured app's recent **releases** into the local index as
`firebase:release` items and exposes three read-only tools to the Nimbus agent
(`firebase_list`, `firebase_get`, `firebase_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set firebase.service_account_json "$(cat service-account.json)"
nimbus vault set firebase.app_ids "1:1234567890:android:abcdef,1:1234567890:ios:012345"
nimbus ask "What are the latest Firebase App Distribution releases for the Android app?"
```

The credentials come from the Google Cloud / Firebase console:

- **`firebase.service_account_json`** — a Google **service account** key JSON
  (the file downloaded from IAM → Service Accounts → Keys) for a service account
  granted the Firebase App Distribution Viewer (or Admin) role.
- **`firebase.app_ids`** — a comma-separated list of Firebase **app ids** (the
  `1:<projectNumber>:<platform>:<hash>` strings from the Firebase console). The
  project number is the second colon-segment and is derived automatically.

The Gateway injects them as `FIREBASE_SERVICE_ACCOUNT_JSON` / `FIREBASE_APP_IDS`
env at spawn time; the connector itself never touches the vault, and both must
be set or the connector no-ops.

## Authentication

App Distribution's REST API is a Google Cloud API: it accepts a short-lived
OAuth2 **Bearer** access token. The connector mints that token from the service
account key using the **JWT-bearer grant** — it signs an RS256 JWT assertion
(scope `cloud-platform`, `aud` = the SA's `token_uri`) with `node:crypto` and
exchanges it at `https://oauth2.googleapis.com/token` for an access token. No
`googleapis` dependency. The minted token is cached in-process and refreshed
conservatively (~30 min). The gateway-side syncable
(`packages/gateway/src/connectors/firebase-sync.ts`) walks
`GET /v1/projects/<projectNumber>/apps/<appId>/releases` for each configured app
and upserts each release with metadata
`{ app_id, display_version, build_version, create_time, release_notes_text,
firebase_console_uri, testing_uri, binary_download_uri }`. The
`binary_download_uri` is stored as a string but its contents are **never
fetched** — it is a binary download link, not data to index.

Tools exposed:

| Tool              | Purpose                                                                            |
| ----------------- | --------------------------------------------------------------------------------- |
| `firebase_list`   | List the configured app ids, or recent releases for an app (pageSize optional).   |
| `firebase_get`    | Fetch a single release by `appId` + `releaseId`.                                   |
| `firebase_search` | Substring search across an app's recent releases (display/build version, notes).   |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
actions (create/distribute a release, manage tester groups) are deferred — the
roadmap row scopes this connector to read-only mobile release observability.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0

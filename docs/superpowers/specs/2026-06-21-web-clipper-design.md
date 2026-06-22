# Web Clipper — Design Spec

**Date:** 2026-06-21
**Status:** Approved (brainstorm) — ready for implementation plan
**Phase:** 6 / Slice 9 (Deferred from Phase 5 → "Browser & Reading")
**Roadmap row:** `docs/roadmap.md` § Phase 6 → Deferred from Phase 5 → Browser & Reading → "Web clipper"

## Summary

A browser extension (Chrome + Firefox, WebExtensions MV3) that saves the current
web page into the Nimbus local index with tags, plus an on-demand "sidecar"
overlay that shows related local items without leaving the tab. Clipped pages
become first-class `web_clip` items and surface in `nimbus search` alongside
Drive files, emails, and bookmarks.

The extension is the **inbound-push** analogue of the existing SCIM / Teams /
deployment-annotation routes: an external client pushing data *into* the gateway
over the I13 HTTP write surface. No MCP connector process is involved — the
engine never pulls; the browser pushes.

## Goals

- Clip the readable article (Mozilla Readability) **or** the current text
  selection from any page into the local index.
- Tag clips at capture time; re-clipping an article updates the existing item.
- Clips are semantically + full-text searchable via `nimbus search`.
- On-demand sidecar overlay surfaces related local items for the current page.
- Pairing-based, owner-consented authentication between extension and gateway.

## Non-Goals (this spec)

- Chrome Web Store / AMO publishing — we ship dev-loadable / sideloadable builds;
  store submission is a follow-on.
- Safari (requires an Xcode/Swift wrapper, macOS-only) — deferred.
- Auto-on-page-load sidecar — explicitly rejected for privacy/perf; on-demand only.
- Full raw-HTML archival — we store readable text, not the whole DOM.
- Any outbound action from clipped content (no HITL, no egress — see Security).

## Architecture

Three independently-testable units:

```text
┌─────────────────────────┐         ┌──────────────────────────────────┐
│  Browser Extension (MV3) │  HTTP   │  Gateway (127.0.0.1, I13 surface) │
│  Chrome + Firefox        │ ──────► │                                   │
│  • popup (clip button)   │ bearer  │  POST /v1/clips        (ingest)   │
│  • content script        │         │  POST /v1/clips/pair/confirm      │
│    - Readability extract │         │  POST /v1/clips/related (read)    │
│    - selection capture   │ ◄────── │                                   │
│    - sidecar overlay     │  JSON   │  → upsertIndexedItem(             │
│  • service worker (token)│         │      service:"nimbus",            │
│  • options (pairing UI)  │         │      type:"web_clip")             │
└─────────────────────────┘         │  → embedding routing → search     │
                                     └──────────────────────────────────┘
     owner runs `nimbus clip pair` → opens pairing window + prints code
```

New package: `packages/browser-extension/` (MV3 source, esbuild/vite build,
separate Chrome + Firefox manifests). Lives outside the bun coverage floor; its
pure logic is unit-tested, its browser-integration parts are dev-loaded.

## Components & Data Flow

### Clip flow

1. User clicks **Clip this page** in the popup (article mode), or **Clip
   selection** when text is highlighted.
2. Content script extracts the main article via Mozilla Readability, or returns
   the current selection text.
3. Service worker POSTs to `POST /v1/clips` with the bearer token:

   ```jsonc
   {
     "url":          "https://example.com/post?utm=...",
     "canonicalUrl": "https://example.com/post",
     "title":        "Page Title",
     "mode":         "article" | "selection",
     "body":         "…readable text or selection…",
     "tags":         ["research", "work"],
     "capturedAt":   1750000000000
   }
   ```

4. Gateway validates, upserts a `web_clip` item, routes it through the embedding
   pipeline, and returns `{ id, status: "created" | "updated" }`.

### Pairing flow

1. Owner runs `nimbus clip pair --label <device>` on the trusted CLI (label
   defaults to a generated name, e.g. `device-1`). The label is supplied on the
   **trusted side** — the browser never names itself.
2. Gateway opens an **in-memory pairing window**: a single-use code, TTL ~120s,
   attempt cap (e.g. 5), carrying the chosen label. The code is printed on the
   CLI (never over the wire).
3. User enters the code in the extension options page.
4. Extension POSTs `{ code }` to `POST /v1/clips/pair/confirm`.
5. Gateway constant-time-compares the code (I10); on match it mints a token,
   stores it under the window's label in the Vault token map
   (`http_api.web_clipper_tokens`, a `{ label: token }` JSON map), closes the
   window, and returns the token to the extension (stored in extension storage).
   Re-pairing with an existing label **replaces** that label's token (rotation);
   a new label **adds** a concurrently-valid token — so Chrome and Firefox can be
   paired at the same time.
6. **Fail-closed:** no active, unexpired, attempts-remaining window → no mint
   (HTTP 403), regardless of input.

**Pairing-window lifecycle:** the window is **strictly in-memory** (a singleton
controller + timer). A gateway restart or crash invalidates any open window —
the owner simply re-runs `nimbus clip pair`. *Minted tokens*, by contrast, live
in Vault and **persist** across restarts; only `nimbus clip revoke` removes them.

### Sidecar flow (on-demand)

1. User triggers the toolbar icon or hotkey.
2. Content script collects page `title` + `canonicalUrl` + any selection.
3. Service worker POSTs to `POST /v1/clips/related` (bearer-authed, **read-only**,
   no DB mutation), which runs the existing hybrid search over the local index.
   **Signal-combining rule:** when a selection is present it is the **primary
   semantic query**; otherwise the `title` is. The `canonicalUrl` host is used to
   **de-prioritize the page's own domain** so a page never just returns itself.
   URL/title keywords ride the existing hybrid (FTS + vector) blend — no new
   ranking machinery.
4. Extension renders an overlay panel in a **Shadow DOM** listing related local
   items: title, service badge, snippet, link. Shadow DOM blocks selector
   matching but **inherited** properties (`font-family`, `color`, `line-height`,
   `:root` custom properties) still cross the boundary, so the sidecar root
   applies an `all: initial` reset and sets its own typography/colors — the host
   page cannot distort the panel.

## Data Model

Unified item table, `service = "nimbus"`, `type = "web_clip"`:

| Field           | Value                                                            |
| --------------- | --------------------------------------------------------------- |
| `external_id`   | article → `clip:<sha256(canonicalUrl)>` (re-clip upserts); selection → `clip:<sha256(canonicalUrl)>:<sha256(selectionText)>` so highlights don't collide |
| `title`         | page title (or a derived title for selections)                  |
| `body_preview`  | first 512 chars of the captured body (FTS-indexed)              |
| `url`           | as-clipped URL                                                  |
| `canonical_url` | normalized URL (tracking params stripped)                      |
| `modified_at`   | `capturedAt`                                                    |
| `metadata` JSON | `{ tags, mode, wordCount, clippedAt }`                          |

**Embedding routing:** add `nimbus:web_clip` to `PROSE_HEAVY_TYPES`
(`packages/gateway/src/embedding/routing.ts`) → OpenAI 1536-dim, with the
standard fall-back to local MiniLM-384 when no `openai.api_key` is configured.
Clips then appear in `nimbus search` results automatically via both the dual
vector path and the FTS5 `item_fts` path.

## Security Posture

- **I6 (unchanged)** — gateway stays bound to `127.0.0.1`; the extension only
  ever talks to localhost.
- **I13** — `POST /v1/clips` and `POST /v1/clips/pair/confirm` are added to
  `WRITE_ROUTE_ALLOWLIST` (currently 6 entries → 8); the count assertion in
  `http-write-routes.test.ts` updates in the same commit.
  `POST /v1/clips/related` is classified as a **read** (bearer-authed, audited on
  rejection, performs no DB mutation) and must not be added to the write
  allowlist — its read-only nature is asserted by test.
- **I10** — constant-time compare for both the pairing code and the bearer token
  (reuse `util/timing-safe-compare.ts`). With a multi-token map, the bearer check
  iterates **all** stored tokens with a constant-time compare each and accepts on
  any match — never short-circuiting in a way that leaks the active token count.
- **No HITL on clip ingest** — clipping is *inbound* (writes into the local
  index, produces no outbound egress), consistent with the deployment / SCIM /
  Teams inbound routes, none of which are HITL-gated. It is **not**
  egress-ledgered (I29 governs *outbound* actions only). The single consent
  moment is the owner-initiated `nimbus clip pair`.
- **New invariant I30 — pairing-window fail-closed.** A web-clipper token is
  minted only behind a live, owner-opened, unexpired, single-use,
  attempts-remaining pairing window; absent such a window the confirm endpoint
  mints nothing (fail-closed). Per the triple rule, the production wiring + the
  `docs/SECURITY-INVARIANTS.md` row + the enforcement test in
  `security-invariants.test.ts` land in the same commit. (I28 remains reserved;
  I29 is the current max → next free is I30.)
- **Threat-model note (documented, not solved):** each minted token lives in
  browser extension storage, outside the Vault boundary. Tokens are local-scope
  (localhost-only, clip + related-read). Because the gateway cannot reach into
  browser storage, **`nimbus clip revoke` is the cut-off mechanism** for a lost or
  compromised extension: revoking a label (or `--all`) deletes the token(s) from
  the Vault map so any browser still holding them gets a 401.

## Error Handling

| Condition                       | Behavior                                              |
| ------------------------------- | ---------------------------------------------------- |
| Gateway unreachable             | Extension shows "Can't reach Nimbus" + retry         |
| Expired / invalid / revoked token | HTTP 401 → extension prompts re-pair                |
| Wrong / expired pairing code    | HTTP 403; window survives to TTL / attempt cap       |
| Readability finds no article    | Fall back to a title + URL bookmark with a notice    |
| Oversized body                  | Body capped (preview 512; stored body truncated)     |
| Duplicate article clip          | HTTP 200 `{ status: "updated" }`                     |
| Rate limit exceeded             | HTTP 429 (per-token-fingerprint, mirrors deployments)|

## Testing

- **Gateway (bun, ≥80% line + branch floor on new files):**
  - Clip route: schema validation, article-vs-selection branching, dedup/upsert,
    `web_clip` routing tag, oversize handling.
  - Pairing: code compare, single-use, **fail-closed-no-window**, TTL expiry,
    attempt cap, rate limit.
  - Related-search read: returns hits, performs no mutation.
  - `security-invariants.test.ts`: new allowlist count (8), I30 pairing
    fail-closed enforcement, `/v1/clips/related` is-a-read assertion.
- **E2E (real gateway subprocess + `fetch` simulating the extension):**
  pair → clip → `nimbus search` finds the clip.
- **Extension (JS unit tests):** Readability wrapper, request/response message
  shapes, token store, canonical-URL normalization. Browser-integration parts
  (popup, content-script injection, sidecar overlay) are dev-loaded / manual.

## CLI Surface

- `nimbus clip pair [--label <device>]` — open a pairing window, print the
  one-time code, wait for confirm (or timeout). Prints success/failure and the
  label the token was stored under.
- `nimbus clip status` — list paired devices (labels + token fingerprints, never
  the raw token) and a count; reports "no clipper tokens registered" when empty.
- `nimbus clip revoke [<label> | --all]` — delete one label's token (or every
  token) from the Vault map, immediately cutting off any browser holding it.
- (Reads/searches reuse existing `nimbus search`; no new search command.)

All three are CLI → gateway over the local IPC socket (JSON-RPC), **not** HTTP —
so they add no entries to the HTTP write allowlist. Only the browser-facing
`/v1/clips` and `/v1/clips/pair/confirm` do.

## Open Decisions (resolved at brainstorm)

1. **Scope:** full thing in one spec (ingestion + extension + sidecar).
2. **Capture:** readable article by default, raw selection when text is selected.
3. **Sidecar:** on-demand only.
4. **Auth:** pairing handshake (owner-opened window + one-time code → token).
5. **Browsers:** Chrome + Firefox (MV3); Safari deferred.
6. **Invariant:** new I30 for the pairing window (vs. folding under I13) — adopt I30.
7. **`/v1/clips/related`:** POST-but-read endpoint (vs. reusing `GET /v1/items`) — adopt the dedicated read endpoint.
8. **Distribution:** dev-loadable builds now; store submission deferred.

### Resolved at design review (2026-06-21)

See [2026-06-21-web-clipper-design-review.md](./2026-06-21-web-clipper-design-review.md).

1. **Multi-token:** adopt a labeled token map (`http_api.web_clipper_tokens`)
   instead of a single key — required because Chrome + Firefox are both targeted
   and must pair concurrently. Bearer check accepts any active token
   (constant-time per entry).
2. **Sidecar CSS:** the Shadow DOM root applies an `all: initial` reset to block
    inherited typography/color from the host page.
3. **Pairing window:** strictly in-memory; a gateway restart invalidates it
    (minted tokens persist in Vault).
4. **`/v1/clips/related` ranking:** selection-primary (else title) semantic
    query, with the page's own host de-prioritized; no new ranking machinery.
5. **Token management:** add `nimbus clip status` + `nimbus clip revoke
    [<label>|--all]` — revoke is the security cut-off for browser-stored tokens.

### Resolved post-plan (2026-06-22)

1. **Repository home:** the whole feature stays in the Nimbus **monorepo** — Plan A
    in `packages/gateway` + `packages/cli` (it is gateway internals: I13 routes, I30,
    IPC, the `web_clip` type — physically inseparable), Plan B in
    `packages/browser-extension/` (matches the `packages/vscode-extension` precedent;
    keeps the HTTP wire contract atomic with the gateway). Promotion to a standalone
    repo under the `nimbus-agent` org is deferred until store submission, when the
    contract is stable and the store-release lifecycle benefits from separation. A
    separate repo was rejected now because it would turn the wire contract into a
    hand-synced cross-repo coupling.

## Files Touched (anticipated)

| Area                  | Path                                                          |
| --------------------- | ------------------------------------------------------------ |
| Write routes          | `packages/gateway/src/ipc/http-write-routes.ts` (+ test)     |
| Auth / vault key      | `packages/gateway/src/ipc/http-auth.ts`                      |
| HTTP server dispatch  | `packages/gateway/src/ipc/http-server.ts`                    |
| Related-read endpoint | `packages/gateway/src/ipc/http-server.ts` (read path)        |
| Pairing window        | new `packages/gateway/src/clips/pairing-window.ts`           |
| Token map (Vault)     | new `packages/gateway/src/clips/clip-token-store.ts` (`http_api.web_clipper_tokens` map: pair/list/revoke/verify) |
| Clip ingest handler   | new `packages/gateway/src/clips/clip-ingest.ts`              |
| Item upsert           | `packages/gateway/src/index/item-store.ts` (reuse)           |
| Embedding routing     | `packages/gateway/src/embedding/routing.ts`                  |
| Security invariants   | `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md` |
| CLI                   | `packages/cli/src/commands/clip.ts` (`nimbus clip pair` / `status` / `revoke`) |
| Extension             | new `packages/browser-extension/` (MV3, Chrome + Firefox)    |
| Roadmap / CHANGELOG   | `docs/roadmap.md`, `docs/CHANGELOG.md`                       |

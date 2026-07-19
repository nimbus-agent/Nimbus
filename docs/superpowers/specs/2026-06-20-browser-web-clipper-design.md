# Browser Web-Clipper (Ingest Surface) — Design

> **SUPERSEDED (2026-07-19).** Shipped as built, with deviations from this design: the item type is `web_clip` under the `nimbus` service (not `web:page`), the Vault key is `http_api.web_clipper_tokens`, and pairing is gated by invariant **I30**. Gateway side shipped 2026-06-22 (#718); the Chrome/Firefox MV3 extension shipped `v0.1.0` on 2026-07-19 from `nimbus-agent/nimbus-web-clipper`. Kept for historical rationale only — see [`docs/roadmap.md`](../../roadmap.md) and [`docs/CHANGELOG.md`](../../CHANGELOG.md) for the as-built record.

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 ingest surface — `docs/roadmap.md` "Phase 6 → Slice 9 (Deferred from Phase 5) → Browser & Reading → Web clipper" (line ~847, unchecked). Conceptually an **ingest surface** (widens how data enters the local index), not a query/act surface.
**Scope:** New AGPL route logic in `packages/gateway/src/ipc/` (extend `http-write-routes.ts` + a new `web-capture-rpc.ts`) reusing the I13 dispatcher; reuse `index/item-store.ts` (`upsertIndexedItem`) + `embedding/routing.ts` (`PROSE_HEAVY_TYPES`); a new MIT client `packages/browser-extension/`; one `[web_capture]` block in `config/nimbus-toml.ts`; a `nimbus web` CLI subcommand for token management. **No schema migration** (see below). **No new invariant** (see below).

---

## Motivation / Goal

Today every byte in the local index arrives through a sync handler on a first-party MCP connector (`packages/mcp-connectors/*`) polling a cloud API. There is no way to capture **the page the user is reading right now** — a vendor docs page, a blog post, an RFC, a GitHub gist viewed in the browser — into the private index. Most "Nimbus family" ideas add a *query* surface or an *act* surface; this adds the missing **input** surface so that `nimbus search` and the built-in agents (catchup/expert/impact) can reason over the user's actual reading trail, not just their connected SaaS.

Goal: a one-click browser capture of `{title, url, selected-text?, snippet}` that lands as a `web:page` item in the local index, searchable alongside Drive files and emails, with **zero new egress** (the extension talks only to `127.0.0.1`) and the local owner in control of what gets indexed.

---

## Where this fits (roadmap home + not-already-shipped evidence)

- **Not shipped.** `docs/roadmap.md` lists "Web clipper" with an unchecked box under Slice 9 → Browser & Reading. The only completed Slice-9 sub-project is the Mendeley connector (`packages/gateway/src/connectors/mendeley-reference-mapping.ts`, shipped 2026-06-14, read-only `reference` type). `Grep` for `web:page` / `web_capture` / a `"web"` service across `packages/gateway/src` returns **no matches** — clean addition. No branch exists.
- **Reuses shipped subsystems** rather than rebuilding:
  - I13 HTTP write surface — `packages/gateway/src/ipc/http-write-routes.ts` (`dispatchWriteRoute`, `WRITE_ROUTE_ALLOWLIST`), `http-auth.ts` (`requireBearer` → constant-time compare, I10), `http-rate-limit.ts` (`HttpWriteRateLimiter`). The existing `POST /v1/deployments` route already proves an HTTP write that lands in the index DB (`deployment-rpc.ts` → `annotateDeployment` writes through the writable handle opened in `http-server.ts`). Web-capture is the same shape: external local process → bearer-auth → rate-limit → audit → index write.
  - Ingest primitive — `index/item-store.ts` `upsertIndexedItem()` (atomic metadata upsert; bound params via `db/write.ts` `dbRun`, I14) + `upsertIndexedItemForSync()` (embedding-queue hook).
  - Embedding routing — `embedding/routing.ts` `PROSE_HEAVY_TYPES` + `isProseHeavy()`; web pages are paragraph-shaped prose → MiniLM-only fallback when `openai.api_key` is absent (same posture as `imap:email`).
  - Mapper pattern — `connectors/mendeley-reference-mapping.ts` + `connectors/mapped-row.ts` `MappedRow<S,T>` is the exact template for mapping third-party metadata to an item row.
  - Client reference — `packages/vscode-extension` (MIT) is the model for a first-party client-side extension.
- **Roadmap repositioning note:** the Phase 7+ resequence (`docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md`) does **not** mention the web-clipper in spine S1–S5 or Track 2/3. This spec treats it as a standalone ingest surface; the owner may choose to slot it under S1 (Local Brain / private-context moat) since it directly grows the private-context corpus.

---

## Approaches considered

### A. Browser extension → I13 HTTP write surface (`POST /v1/web/capture`) — **recommended**

The extension POSTs a small JSON payload to `http://127.0.0.1:<httpPort>/v1/web/capture` with a `Bearer` token. The route is added to `WRITE_ROUTE_ALLOWLIST`, dispatched through the existing `dispatchWriteRoute` pipeline (bearer auth, per-token rate-limit, 8 KB body cap, audit-on-rejection), then maps the body to a `web:page` item via `upsertIndexedItem`.

- **+** Reuses the entire, already-hardened I13 pipeline — auth, rate-limit, body-cap, audit, the `writeDb` handle, the count-integrity test. The HTTP server already binds `127.0.0.1` only (`http-server.ts` line 540), so I6 is satisfied natively with no new code.
- **+** Browsers can do `fetch()` to localhost from a background service worker; they **cannot** bind a Unix socket or the JSON-RPC IPC pipe, so HTTP is the only viable transport.
- **+** Symmetric with the existing deployment write route — same review surface, same `nimbus-http-write-surface` skill.
- **−** Adds the 7th write route (the count test must be bumped 6 → 7 in the same commit). Acceptable — that *is* the integrity gate.
- **−** Requires shipping + publishing a browser extension (Chrome Web Store + Firefox Add-ons), which is real client surface to maintain.

### B. Clipboard / file-drop watcher (no extension)

A "Save to Nimbus" bookmarklet copies a JSON blob to the clipboard or writes a `.json` into a watched `[[filesystem.roots]]` drop folder; the gateway watches and ingests.

- **+** No browser-store publishing, no extension review cycle.
- **−** Clipboard capture is fragile and racy; a watched drop-folder reuses filesystem indexing but gives a clumsy UX (manual save-as into a magic folder). No selected-text affordance, no one-click.
- **−** Loses the auth boundary — anything that can write the folder can inject items. Weaker than a bearer-gated HTTP route.

### C. Full DOM/HTML capture + reader-mode extraction + browser sidecar overlay

Capture the full page HTML, run a Readability-style extraction, store the cleaned article body, and ship the "browser sidecar UI (overlay) to show related local items" described in the roadmap line.

- **+** Richest corpus (full-text FTS over article bodies) and the highest-WOW surface (related-items overlay).
- **−** Large scope: HTML sanitization, content-script DOM injection on arbitrary origins (XSS/CSP risk), an in-page React overlay, a read path back from the gateway into the page. This is several slices, not one. The overlay also needs a *read* surface (related items) which the current HTTP API exposes read-only on different routes — a separate integration.
- **−** Storing full HTML inflates the index and the embedding cost for marginal v1 value.

**Recommendation: A**, scoped to **metadata + optional selected-text only** (no full HTML, no overlay). Reasons: (1) it reuses the most hardened subsystem in the gateway (I13) with the smallest new attack surface; (2) `127.0.0.1`-only HTTP is already the bind default, so local-first + no-egress fall out for free; (3) it delivers the core value — "the page I'm reading is now searchable" — in a single implementation plan. The full-HTML body and the sidecar overlay (approach C) are explicitly deferred to a **Wave 2** once the ingest spine is proven.

---

## Design (recommended)

### Architecture & components

**Gateway (AGPL) — route + mapper + ingest**

- `packages/gateway/src/ipc/http-write-routes.ts` (extend): add `ROUTE_WEB_CAPTURE = "POST /v1/web/capture"` to `WRITE_ROUTE_ALLOWLIST`; add a `RouteKind` `"webCapture"`; add `resolveWebCaptureRoute()` (404 unless the seam is enabled, mirroring `resolveScimCreateRoute`); add a `WebCaptureSurface` seam `{ token: string; onCapture: (body: unknown, nowMs: number) => Promise<WebCaptureResult> }`; dispatch `route.kind === "webCapture"` to `runWebCaptureRoute()`. Bearer = the dedicated web-capture token (NOT the deployment token — its own Vault key, like SCIM has its own).
- `packages/gateway/src/ipc/web-capture-rpc.ts` (new): `dispatchWebCaptureRpc()` validates the body (`unknown` → typed via `asRecord`/`stringField` helpers, no `any`), enforces field caps, calls `mapWebPageToItem()` then `upsertIndexedItem()`/`upsertIndexedItemForSync()`. Returns a leak-proof `{ data: { itemId } }` (the same envelope the HTTP route emits; never echoes secrets). Throws a typed `WebCaptureRpcError` on validation failure (mirrors `DeploymentRpcError`).
- `packages/gateway/src/connectors/web-page-mapping.ts` (new): `mapWebPageToItem(raw, ctx): MappedRow<"web", "page"> | null` — the Mendeley-mapper template. Title clipped to 120, snippet/selection clipped, `externalId` = a deterministic hash of the normalized URL (so re-capturing the same page upserts, not duplicates). The persisted `url` is the **canonical/redacted** URL — `canonicalizeUrl()` strips the entire query string and fragment (and any known auth-token params, e.g. `token`/`access_token`/`sig`/`signature`/`utm_*`) so signed links and auth tokens never land in the index; the raw URL is never stored. `metadata = { source: "web_clipper", url /* canonical/redacted */, title, snippet, selection?, capturedAt, browserContext, extensionVersion }`. The `source: "web_clipper"` tag is filterable in `nimbus search` and distinguishes clipped pages from connector-synced items.
- `packages/gateway/src/embedding/routing.ts` (extend): add `"web:page"` to `PROSE_HEAVY_TYPES`.
- `packages/gateway/src/ipc/http-server.ts` (extend): add `resolveWebCaptureToken?: () => Promise<string>` to `ReadOnlyHttpServerOptions`; resolve a `webCapture` seam in `resolveWriteRouteDeps()`; include `resolveWebCaptureToken` in the `writeDb`-open condition (so the writable handle opens when the web-capture surface is enabled). The server already binds `127.0.0.1` (line 540).
- `packages/gateway/src/config/nimbus-toml.ts` (extend): a `[web_capture]` block `{ enabled: boolean }` (default `false`). The token lives in Vault (`web_capture.bearer`), never in TOML.

**Client (MIT) — extension**

- `packages/browser-extension/` (new, **MIT** — it is a client like `packages/cli` and `packages/vscode-extension`, reaches the gateway over the local HTTP surface only, imports no gateway source). Manifest V3 (Chromium) + a Firefox-compatible manifest. The bearer is **never persisted at rest** (no `chrome.storage.local`, which is profile-local plaintext — that would violate the no-plaintext-credentials non-negotiable): the background service worker obtains a fresh bearer **per session** via a loopback pairing handshake with the gateway (the owner authorizes once via `nimbus web` against `127.0.0.1`) and holds it **only in ephemeral in-memory worker state**, re-pairing when the worker is evicted. A toolbar action + context-menu "Save selection to Nimbus" builds the payload from `tabs`/`scripting` APIs (title, URL, `window.getSelection()`), POSTs to `http://127.0.0.1:<port>/v1/web/capture`. CSP/manifest blocks all external hosts — the only `host_permissions` entry is `http://127.0.0.1/*` (loopback). No external CDN, no analytics.

**CLI (AGPL)**

- `packages/cli` (extend): `nimbus web token set|show|clear` to provision/rotate the `web_capture.bearer` Vault secret and authorize the loopback pairing handshake (the extension pulls a per-session in-memory bearer from it — there is no paste-into-extension step). `nimbus web enable|disable` toggles `[web_capture].enabled`.

### Data flow

```text
[browser tab] --user clicks "Save"-->  extension service worker
  builds {url,title,snippet,selection?,extensionVersion,browserContext}
  --> POST http://127.0.0.1:<port>/v1/web/capture  (Authorization: Bearer <web_capture.bearer>)
        --> http-server.fetch (127.0.0.1 bind, I6)
            --> dispatchWriteRoute (I13): resolve route -> requireBearer (I10 constant-time)
                -> rate-limit (per-token fingerprint) -> 8KB body cap -> JSON parse
                -> runWebCaptureRoute -> dispatchWebCaptureRpc
                   -> mapWebPageToItem (validate, clip, hash normalized URL -> externalId; persist canonical/redacted URL)
                   -> upsertIndexedItemForSync (dbRun bound params I14; schedule embedding)
                   -> append audit entry {action: web.capture.indexed, token_fingerprint, url-host}
            <-- {data:{itemId}} (leak-proof; never echoes the token)
  [later] nimbus search / catchup / expert  --finds-->  web:page item
```text

### IPC / CLI surface

- **HTTP (external, I13):** `POST /v1/web/capture` — body `{ url, title, snippet?, selection?, extensionVersion, browserContext? }`, bearer `web_capture.bearer`, response `{ data: { itemId } }`. The only new write route. (The optional Wave-2 read route for the sidecar — `GET /v1/web/related` — is a non-goal here.)
- **CLI:** `nimbus web token set|show|clear`, `nimbus web enable|disable`. No new JSON-RPC IPC method on the local socket is required for v1 (capture is HTTP-only; management is Vault/config writes the CLI already does). No Tauri allowlist change (the extension is a separate client, not the renderer).

### Security: check against the 7 Non-Negotiables + invariant/schema impact

1. **Local-first** — ✅ capture target is `127.0.0.1`; the page content never leaves the machine. The browser is a *source*, the gateway index is the source of truth.
2. **HITL is structural** — the **default-off + explicit per-page user click** model means each capture is already a deliberate human action originating in the browser, and `[web_capture].enabled` defaults `false`. **Decision (recommended):** treat web-capture like the deployment annotation route — a bearer-authenticated, audit-logged index write, **not** an executor action — because there is no cloud side-effect to gate (it is a *local* write the user explicitly triggered). It therefore does **not** enter `HITL_REQUIRED_BACKING` (`engine/executor.ts`). This preserves the non-negotiable: the executor gate is untouched and un-bypassed; web-capture simply isn't an executor action. **Resolved (Open Q1):** captures write **directly into the index** on the fast path, tagged `source: "web_clipper"` in `metadata` (filterable in `nimbus search`) — there is **no** pre-index review queue. A review queue (a Wave-2 `web.capture` executor action added to the frozen set) is added **only if later requested**.
3. **No plaintext credentials** — ✅ the bearer lives in Vault (`web_capture.bearer`) on the gateway side, never in TOML, logs, or IPC. On the **extension** side the bearer is never written to disk — no `chrome.storage.local` (that is profile-local plaintext at rest); the extension fetches a fresh bearer per session via the loopback pairing handshake and keeps it **in-memory only**, re-pairing after worker eviction. The audit entry logs only the **token fingerprint** (sha256 8-hex, via `tokenFingerprint`) and the URL host, never the token or full URL query string.
4. **MCP as connector standard** — ⚠️ web-capture is an **ingest surface, not a connector** — it does not call any cloud API (the non-negotiable governs the engine never calling cloud APIs directly; capture pulls from the browser, not the cloud). It writes through the same `upsertIndexedItem` primitive that connectors use, so the index contract is identical. No cloud API is touched anywhere in this design.
5. **Platform equality** — ✅ the route + mapper are pure TS, OS-agnostic; the extension targets Chromium + Firefox on all three OSes. Vault token storage uses the existing PAL.
6. **AGPL-3.0 core / MIT SDK** — ✅ the route/mapper/RPC logic lives in `packages/gateway` (AGPL-3.0-only, verified in `gateway/package.json`). The new `packages/browser-extension/` is **MIT**, matching the existing client precedent: `packages/vscode-extension/package.json` is `"license": "MIT"`. (This corrects the grounding note that assumed AGPL for the extension — clients are MIT; only the gateway route logic is AGPL, and it stays in the gateway package.)
7. **No `any`** — ✅ the POST body arrives as `unknown` and is narrowed with the existing `asRecord`/`stringField`/`numberField` helpers (`connectors/unknown-record.ts`); strict mode throughout.

**Invariant impact:**

- **Reuses I13** (`http-write-routes.ts` dispatcher + `WRITE_ROUTE_ALLOWLIST` + bearer + rate-limit + audit). Concrete edit: bump the count-integrity test in `security-invariants.test.ts` from `WRITE_ROUTE_ALLOWLIST.length === 6` to `7` and add `"POST /v1/web/capture"` to the asserted array — **in the same commit** as the route (the triple rule).
- **Reuses I6** — the HTTP server already binds `127.0.0.1` (`http-server.ts` line 540); the extension's `host_permissions` are loopback-only. No remote caller can reach the route.
- **Reuses I10** — bearer compared via `requireBearer` → `constantTimeStringEqual`.
- **Reuses I14** — the ingest write goes through `upsertIndexedItem` → `dbRun` (bound params).
- **No new invariant.** The grounding floated a "CANDIDATE I29" for signed-origin/replay defense. **Rejected for v1 as YAGNI:** the bearer is a high-entropy Vault secret that only the owner can copy into their own extension on their own machine; an attacker who can present the bearer to `127.0.0.1` already has local code execution. A signed-origin scheme adds an extension-side keypair, a server-side verifier, and a static-audit rule for marginal benefit over "Vault bearer + loopback + audit". If a future threat model (e.g. shared multi-user machines) demands it, it would be **I29** (note: **I28 is reserved** for the unmerged MCP-server owner-sink on `dev/asafgolombek/phase7-mcp-gateway-server`).
- **No schema migration / no V44.** The `item` table is generic; Mendeley added the `reference` type with **zero migration** by putting type-specific fields in the `metadata` JSON. Web-capture follows the identical pattern: a new `web:page` type, `web_capture`-shaped fields in `metadata` JSON. The `local-index` schema test should document the `web:page` type + metadata shape, but no DDL changes. (This corrects the grounding's "CANDIDATE V44".)

**Fail-closed behavior:** surface disabled (no Vault token / `enabled=false`) → the route 404s (seam absent) and the writable handle never opens; empty expected token → `requireBearer` returns `surfaceDisabled` → `503 write_surface_disabled`; bad bearer → `401` + audit rejection; over-rate → `429` + audit; oversized/invalid body → `413`/`400` + audit; mapper returns `null` (missing url/title) → `400`, no write. No silent partial writes.

### Testing (which layer)

- **Integration (gateway, real SQLite + real `Bun.serve`):** POST a valid capture → assert a `web:page` row in `item` with the right `metadata` JSON, embedding scheduled, audit entry written with the token fingerprint (not the token). Re-POST same URL → upsert (one row, not two). Wrong bearer → 401 + audit. Disabled surface → 404. Over-cap body → 413. Rate-limit exhaustion → 429.
- **Security-invariant test:** the bumped `WRITE_ROUTE_ALLOWLIST.length === 7` + exact-array assertion (the integrity gate).
- **Unit:** `mapWebPageToItem` table-tests (URL normalization/hash determinism, field clipping, null on missing fields, no `any`) and the routing assertion `isProseHeavy("web","page") === true`.
- **Vault-leak test:** assert no path returns the bearer in any response body or audit `action_json` (only the fingerprint + URL host).
- **E2E CLI:** `nimbus web token set` then a curl-equivalent capture against a real gateway subprocess → `nimbus search` finds the page.
- **Extension:** lightweight unit tests on the payload-builder (MIT package); no real-browser E2E in v1 (manual smoke). Coverage floor ≥80% line+branch applies to every new gateway file (`web-capture-rpc.ts`, `web-page-mapping.ts`, the `http-write-routes.ts` additions).

---

## Non-goals (YAGNI)

- **No full-page HTML capture / reader-mode extraction** — metadata + optional selected-text only. (Wave 2.)
- **No browser sidecar overlay / related-items panel** — the roadmap's "sidecar UI" and its required `GET /v1/web/related` read route are deferred. (Wave 2.)
- **No signed-origin / replay-defense invariant (I29)** — Vault bearer + loopback + audit is sufficient for the single-owner local threat model.
- **No new schema migration / V44** — generic `item` table + JSON metadata.
- **No Safari extension** — Chromium + Firefox only in v1.
- **No auto-capture / background scraping** — every capture is an explicit user click. No "save everything I browse" mode.
- **No Tauri/renderer exposure** — the extension is its own client; no `ALLOWED_METHODS` change.
- **No new executor action / HITL frozen-set entry** — resolved (Open Q1): captures write directly into the index (tagged `source: "web_clipper"`); a review-queue executor action is a deferred Wave-2 add only if later requested.

## Open questions

1. **HITL posture — RESOLVED:** ship as a direct bearer-authed index write — captures land **directly in the index** on the fast path, tagged `source: "web_clipper"` in `metadata` (filterable in search), **not** a pre-index review queue. Rationale: a deliberate per-page user click with no cloud side-effect; the executor gate stays untouched. A review queue becomes a deferred Wave-2 `web.capture` executor action (same-commit triple-rule change) **only if later requested**.
2. **Distribution:** bundle/auto-publish the extension with the Nimbus release (like `vscode-extension`), or publish independently to the stores on its own cadence?
3. **Extension ↔ gateway pairing UX — RESOLVED (no plaintext at rest):** a short-lived loopback pairing-code handshake (Phase-6 pattern) so the extension obtains a **per-session, in-memory-only** bearer; manual paste into `chrome.storage.local` is **rejected** because it persists the credential in profile-local plaintext (violates the no-plaintext-credentials non-negotiable). Open detail: exact handshake shape (re-use the Phase-6 pairing-code flow vs. a dedicated `nimbus web pair` step) and the gateway-side ability to revoke a paired session.
4. **URL `externalId` hashing:** normalize away query strings/fragments before hashing (so `?utm_*` variants dedupe) — confirm the normalization rules.
5. **Roadmap slotting:** keep under Slice 9, or reposition under spine **S1 (Local Brain)** as a private-context-corpus growth lever, per the Phase 7+ resequence?

## Acceptance criteria

- [ ] `POST /v1/web/capture` exists in `WRITE_ROUTE_ALLOWLIST`; the security-invariant count test asserts `length === 7` with the exact array, landed in the same commit as the route.
- [ ] A valid bearer-authed capture writes exactly one `web:page` item **directly into the index** (no review queue), tagged `source: "web_clipper"` in `metadata` and filterable by it in `nimbus search`; re-capture upserts; it schedules its embedding and writes an audit entry containing the token **fingerprint** and URL host but never the token or the secret.
- [ ] Disabled surface 404s and never opens the writable handle; bad bearer 401s; over-cap 413s; over-rate 429s; invalid/missing-field body 400s — all fail-closed, all audited where applicable.
- [ ] `isProseHeavy("web","page")` is `true`; captures embed via MiniLM when `openai.api_key` is absent.
- [ ] `nimbus web token set` + a real capture against a live gateway → the page is found by `nimbus search`.
- [ ] `packages/browser-extension/package.json` is `"license": "MIT"`; its only `host_permissions` is `http://127.0.0.1/*`; manifest blocks all external hosts.
- [ ] All seven Non-Negotiables hold; no new invariant, no schema migration; every new gateway file ≥80% line+branch coverage; `bun run preflight:fast` green.

# Implementation Plan Review: Multimodal PR 3 — Cloud Byte-Fetch (2026-09-04)

**Date:** 2026-09-04  
**Review Target:** [`2026-09-04-multimodal-pr3-cloud-arm.md`](file:///C:/gitrep/Nimbus/docs/superpowers/plans/2026-09-04-multimodal-pr3-cloud-arm.md)  
**Status:** Review Complete  

---

## 1. Executive Summary

The **Multimodal PR 3 (Cloud Byte-Fetch)** implementation plan is well-conceived, principled, and builds cleanly on the foundations established in PR 1 and PR 2. Key architectural strengths include:

1. **SQL-Level Mime Filtering (Task 5):** Moving candidate filtering into SQL prevents catastrophic cursor starvation on generic `type: "file"` connectors (Google Drive, OneDrive).
2. **Strict Credential Boundary (Task 8 & 9, Spec § 16.4):** Enforcing that credentials ride only on URLs constructed by Nimbus (`driveByteUrl`), while provider-returned pre-signed URLs (`google_photos`, `onedrive`) carry no `Authorization` header.
3. **Egress Completeness (Task 9, I29):** Pre-request `sync`-class egress appends with fail-closed abort semantics preserve ledger integrity.
4. **Resumable Streaming Budget (Tasks 4, 9, 11):** Chunk-level budget accounting with `AbortController` unwinding prevents runaway bandwidth and quota consumption while maintaining clean pass resumption.
5. **Proactive Debt Rectification (Tasks 1, 2, 3):** Resolving the unread `sourceBytes` defect, implementing the missing `derivedFrom` orphan pruning, and extending scratch-file sweeping to extensionless cloud artifacts.

This review identifies **5 critical implementation blockers / bugs** (including a disconnected cloud byte URL resolution pipeline, missing scratch-file cleanup for cloud AV in `media-pass.ts`, broken CLI argument parsing for boolean flags, and missing `https:` pinning on provider URLs), **5 operational reliability & performance improvements**, and **3 open questions** for architectural alignment.

---

## 2. Critical Implementation Blockers & Bugs

### 2.1 Missing Cloud Byte-URL Resolution Pipeline in Tasks 8, 9, and 11

* **Context:**
  * Spec § 16.6 states that Google Photos `baseUrl` expires in ~1 hour and must be re-resolved via `GET photoslibrary.googleapis.com/v1/mediaItems/{id}` with a Bearer token.
  * OneDrive requires fetching `@microsoft.graph.downloadUrl` from Microsoft Graph API (`GET /me/drive/items/{id}`) with a Bearer token.
  * Plan Overview (lines 7, 42–43, 902, 1556) references exporting resolvers from `{google-photos,google-drive,onedrive}-sync.ts` and minting a `fetchBytes` capability in `sync/sync-capabilities.ts`.
* **Issue:**
  1. **Task 8** only defines pure URL string helpers (`driveByteUrl`, `photosByteUrl`, `onedriveByteUrl`). It **does not implement** the Photos `mediaItems/{id}` re-resolution or OneDrive `@microsoft.graph.downloadUrl` resolution, and does not modify the connector sync files.
  2. **Task 9** (`fetchCloudBytes`) accepts a pre-resolved `byteUrl: ByteUrl`.
  3. **Task 11** (`runMediaPass`) loops through candidates and calls `fetchCloudBytes(candidate, ...)` without any mechanism to obtain or construct `byteUrl` for Google Photos or OneDrive candidates.
  4. `sync/sync-capabilities.ts` is never edited in any task.
  5. In production, attempting to process Google Photos or OneDrive candidates will fail because `media-pass.ts` has no way to turn a candidate into a valid `ByteUrl`.
* **Fix:**
  Define the asynchronous URL resolution step explicitly:
  1. In `packages/gateway/src/multimodal/cloud-renditions.ts`, implement a resolver dispatcher:
     ```ts
     export interface CloudUrlResolverDeps {
       readonly bearerFor: (service: string) => Promise<string | null>;
       readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
     }

     export async function resolveCloudByteUrl(
       candidate: MediaCandidate,
       preferRenditions: boolean,
       deps: CloudUrlResolverDeps,
     ): Promise<ByteUrl | { error: SkipReason }> {
       const externalId = candidate.itemId.slice(candidate.service.length + 1);

       if (candidate.service === "google_drive") {
         return driveByteUrl(externalId);
       }

       if (candidate.service === "google_photos") {
         const token = await deps.bearerFor("google_photos");
         if (!token) return { error: "not_configured" };
         const res = await deps.fetchFn(
           `https://photoslibrary.googleapis.com/v1/mediaItems/${encodeURIComponent(externalId)}`,
           { headers: { Authorization: `Bearer ${token}` } },
         );
         if (!res.ok) return { error: "fetch_miss" };
         const data = (await res.json()) as { baseUrl?: string };
         if (!data.baseUrl) return { error: "fetch_miss" };
         return photosByteUrl(data.baseUrl, candidate.modality, preferRenditions);
       }

       if (candidate.service === "onedrive") {
         const token = await deps.bearerFor("onedrive");
         if (!token) return { error: "not_configured" };
         const res = await deps.fetchFn(
           `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(externalId)}?select=id,@microsoft.graph.downloadUrl`,
           { headers: { Authorization: `Bearer ${token}` } },
         );
         if (!res.ok) return { error: "fetch_miss" };
         const data = (await res.json()) as Record<string, unknown>;
         const downloadUrl = data["@microsoft.graph.downloadUrl"];
         if (typeof downloadUrl !== "string" || !downloadUrl) return { error: "fetch_miss" };
         return onedriveByteUrl(downloadUrl);
       }

       return { error: "unresolvable_modality" };
     }
     ```
  2. Wire `resolveCloudByteUrl` directly into `runMediaPass` before invoking `fetchCloudBytes`.
  3. Clean up the file structure list: remove unused references to modifying `sync-capabilities.ts` or connector files unless connector helper exports are specifically preferred.

---

### 2.2 Cloud AV Scratch-File Deletion Omitted in `runMediaPass` (Disk Leak)

* **Context:**
  * Spec § 16.3 states: *"The AV path writes at most two 0600 gateway-owned scratch files — the downloaded artifact (cloud arm only) and its transcode — both deleted in a `finally` and both swept at pass start."*
* **Issue:**
  * In Task 9, `fetchCloudBytes` deletes the temporary scratch file only on **error / abort**. On success, it returns `{ ok: true, kind: "path", path: scratchPath }`.
  * In Task 11 Step 3, `runMediaPass` invokes `understandArtifact(candidate, { kind: "path", path: scratchPath }, deps.gate)` and writes the understanding row.
  * **However, `runMediaPass` does not delete `scratchPath` upon completion.**
  * As a result, every cloud video successfully downloaded remains in `scratchDir` indefinitely until the 1-hour start-of-pass sweeper cleans it up. A pass processing multiple videos will exhaust local disk space.
* **Fix:**
  In `packages/gateway/src/multimodal/media-pass.ts`, ensure that every cloud scratch file is unlinked immediately in a `finally` block:
  ```ts
  const isCloud = candidate.sourcePath === null;
  let cloudScratchPath: string | undefined;

  try {
    let source: MediaSource;
    if (isCloud) {
      const fetched = await deps.cloudFetch(candidate, ...);
      if (!fetched.ok) { /* handle skip/stop */ continue; }
      if (fetched.kind === "path") cloudScratchPath = fetched.path;
      source = fetched.kind === "bytes"
        ? { kind: "bytes", bytes: fetched.bytes, mime: candidate.sourceMime }
        : { kind: "path", path: fetched.path };
    } else {
      const resolved = resolveLocalMediaPath(candidate, deps.roots, deps.maxBytes);
      if (!resolved.ok) { /* handle skip */ continue; }
      source = { kind: "path", path: resolved.path };
    }

    const result = await understandArtifact(candidate, source, deps.gate);
    if (!result.ok) { /* handle skip */ continue; }

    writeUnderstanding(deps.db, candidate, result.outcome, deps.nowMs(), deps.scheduleEmbedding);
    understood += 1;
  } finally {
    if (cloudScratchPath !== undefined) {
      try {
        rmSync(cloudScratchPath, { force: true });
      } catch {
        // file cleanup error should not fail pass
      }
    }
  }
  ```

---

### 2.3 CLI Argument Parsing Broken for Value-less Flags in `media-cmd.ts`

* **Context:**
  * Task 12 adds `--renditions` and `--originals` boolean flags to `nimbus media understand`.
* **Issue:**
  * In `packages/cli/src/commands/media-cmd.ts` lines 87–93:
    ```ts
    for (let i = 1; i < argv.length; i += 2) {
      const flag = argv[i];
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
      }
    ```
  * Stepping by `i += 2` assumes every argument has an accompanying value.
  * If a user executes `nimbus media understand --renditions --limit 10`, `--renditions` will consume `--limit` as its value, or if passed at the end (`nimbus media understand --renditions`), it will throw `"--renditions requires a value"`.
* **Fix:**
  Refactor `parseMediaArgs` loop in `packages/cli/src/commands/media-cmd.ts` to inspect individual tokens and step dynamically:
  ```ts
  let i = 1;
  while (i < argv.length) {
    const flag = argv[i];
    if (flag === "--renditions") {
      params.renditions = true;
      i += 1;
      continue;
    }
    if (flag === "--originals") {
      params.originals = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`nimbus media: ${flag ?? ""} requires a value`);
    }
    switch (flag) {
      case "--service":
        params.service = value;
        break;
      case "--modality":
        params.modality = parseModality(value);
        break;
      case "--limit":
        params.limit = parseLimit(value);
        break;
      case "--since":
        params.sinceDays = parseSinceDays(value);
        break;
      case "--budget":
        params.budgetBytes = parseBudget(value);
        break;
      default:
        throw new Error(`nimbus media: unknown flag "${flag ?? ""}"`);
    }
    i += 2;
  }
  ```

---

### 2.4 Missing `https:` Protocol Enforcement for Provider-Returned URLs in `fetchCloudBytes`

* **Context:**
  * Spec § 16.4 & § 16.12 explicitly mandate: *"A provider-returned URL is additionally pinned to `https:`. A test asserts that a request to a provider-returned URL carries no Authorization header, and that a provider-returned `http:` URL is refused."*
* **Issue:**
  * In Task 9 Step 3, `fetchCloudBytes` delegates directly to `deps.fetchFn(byteUrl.url, ...)`.
  * `safeFetch` permits both `http:` and `https:`.
  * Neither Task 8 nor Task 9 verifies that `byteUrl.kind === "provider"` URLs use `https:`, and Task 9 Step 1 does not include the required test asserting refusal of `http:` provider URLs.
* **Fix:**
  1. In `fetchCloudBytes` (`packages/gateway/src/multimodal/cloud-bytes.ts`):
     ```ts
     if (byteUrl.kind === "provider") {
       let parsed: URL;
       try {
         parsed = new URL(byteUrl.url);
       } catch {
         return { ok: false, reason: "fetch_miss" };
       }
       if (parsed.protocol !== "https:") {
         return { ok: false, reason: "fetch_miss" };
       }
     }
     ```
  2. Add unit test to Task 9 Step 1:
     ```ts
     test("refuses a provider-returned http: URL", async () => {
       const deps = fakeDeps({});
       const insecureUrl: ByteUrl = { kind: "provider", url: "http://example.com/image.jpg", bearer: false };
       const r = await fetchCloudBytes(imageCandidate, insecureUrl, deps);
       expect(r).toEqual({ ok: false, reason: "fetch_miss" });
     });
     ```

---

### 2.5 Header Stripping Across Origin-Crossing Redirects in `safeFetchFollowing`

* **Context:**
  * Task 6 notes: *"Manual following additionally removes any dependency on the runtime's own header handling across an origin crossing."*
* **Issue:**
  * In Task 6 Step 4 (`safeFetchFollowing`):
    ```ts
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const res = await safeFetch(url, { ...init, redirect: "manual" }, deps);
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      if (location === null || location === "") return res;
      url = new URL(location, url).toString();
    }
    ```
  * `init` is passed unchanged across loop iterations. If `init.headers` contains an `Authorization` bearer token (e.g. on a constructed Google Drive URL), a redirect to a different host/origin will forward the `Authorization` header to that third-party host.
* **Fix:**
  In `packages/gateway/src/util/safe-fetch.ts`, strip `Authorization` headers whenever redirecting across origins:
  ```ts
  export async function safeFetchFollowing(
    raw: string,
    init: RequestInit,
    deps?: SafeFetchDeps & { readonly maxHops?: number },
  ): Promise<Response> {
    const maxHops = deps?.maxHops ?? DEFAULT_MAX_HOPS;
    let url = raw;
    let currentInit = { ...init };

    for (let hop = 0; hop <= maxHops; hop += 1) {
      const res = await safeFetch(url, { ...currentInit, redirect: "manual" }, deps);
      if (res.status < 300 || res.status >= 400) return res;

      const location = res.headers.get("location");
      if (location === null || location === "") return res;

      const nextUrl = new URL(location, url).toString();
      if (new URL(nextUrl).origin !== new URL(url).origin) {
        const headers = new Headers(currentInit.headers);
        headers.delete("authorization");
        currentInit = { ...currentInit, headers };
      }
      url = nextUrl;
    }
    throw new Error(`unsafe url: too many redirects (>${maxHops})`);
  }
  ```

---

## 3. Operational, Performance & Reliability Recommendations

### 3.1 Pre-emptive Abort on Declared `content-length > remainingBudget` in `fetchCloudBytes`

* **Observation:** In Task 9 Step 3, `fetchCloudBytes` checks `declared > deps.maxBytes` before streaming, but does not check `declared > deps.remainingBudget`.
* **Improvement:** If the HTTP response headers report `content-length: 500MB` and `deps.remainingBudget` is `10MB`, aborting immediately avoids streaming the first 10MB across the wire before tripping the budget limit:
  ```ts
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared)) {
    if (declared > deps.maxBytes) {
      controller.abort();
      return { ok: false, reason: "over_byte_cap" };
    }
    if (declared > deps.remainingBudget) {
      controller.abort();
      return { ok: false, stop: "budget_exhausted" };
    }
  }
  ```

---

### 3.2 Invariant I14 Compliance in `orphan-prune.ts`

* **Observation:** In Task 2 Step 3, `pruneOrphanedUnderstandings` calls `db.query(...).run(...)` directly.
* **Improvement:** Per Invariant **I14** (`packages/gateway/src/db/write.ts`), SQLite writes should go through `dbStmtRun` or `dbRun` so that `SQLITE_FULL` errors trigger `setDiskSpaceWarning(true)` and raise `DiskFullError`:
  ```ts
  import { dbStmtRun } from "../db/write.ts";

  export function pruneOrphanedUnderstandings(db: Database): number {
    const stmt = db.query(
      `DELETE FROM item
        WHERE service = 'nimbus'
          AND type IN (${UNDERSTANDING_TYPES.map(() => "?").join(", ")})
          AND json_extract(metadata, '$.derivedFrom') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM item AS src
             WHERE src.id = json_extract(item.metadata, '$.derivedFrom')
          )`,
    );
    const result = dbStmtRun(stmt, ...UNDERSTANDING_TYPES);
    return result.changes;
  }
  ```

---

### 3.3 Atomic `0o600` File Creation for AV Scratch Downloads

* **Observation:** In Task 9 Step 3, the scratch file is created and then chmod'd via `chmodSync(path, 0o600)`.
* **Improvement:** On POSIX systems, creating the file with `fs.createWriteStream(path, { mode: 0o600 })` ensures the file is created with restrictive permissions from the exact moment of inode creation, avoiding any microsecond umask exposure window.

---

### 3.4 Flexible Human Unit Parsing in `parseBudget`

* **Observation:** In Task 12 Step 3, `parseBudget` parses strings like `"4GB"`, `"500MB"`.
* **Improvement:** Support binary and metric unit suffixes (`G`, `GB`, `GiB`, `M`, `MB`, `MiB`, `K`, `KB`, `KiB`) case-insensitively:
  ```ts
  export function parseBudget(raw: string): number | null {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }
    const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(trimmed);
    if (!m) return null;
    const num = Number.parseFloat(m[1] as string);
    const unit = (m[2] as string).toUpperCase();
    if (!Number.isFinite(num) || num < 0) return null;

    switch (unit) {
      case "B":
        return Math.round(num);
      case "K":
      case "KB":
      case "KIB":
        return Math.round(num * 1024);
      case "M":
      case "MB":
      case "MIB":
        return Math.round(num * 1024 * 1024);
      case "G":
      case "GB":
      case "GIB":
        return Math.round(num * 1024 * 1024 * 1024);
      default:
        return null;
    }
  }
  ```

---

### 3.5 Extended Documentation Sweep Target in Task 13

* **Observation:** In Task 13 Step 2, the I29 `sync` appender enumeration search targets `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md`, and `.claude/commands/nimbus-egress.md`.
* **Note:** `docs/architecture.md` (line 1837) also explicitly enumerates the `sync` appenders (`sync/scheduler.ts` and `sync/targeted-fetch.ts`). Include `docs/architecture.md` in the Task 13 sweep.

---

## 4. Open Questions

1. **Rendition Metadata Disclosure on Derived Rows:**
   Spec § 16.8 states that the derived item's body or metadata must disclose which rendition it was understood from (e.g., `rendition: "2048px"` vs `"original"`). Should `buildUnderstandingRow` in `understanding-item.ts` accept an optional `rendition?: string` field to attach to `metadata`?
2. **Partial Byte Accounting on Mid-Stream Budget Abort:**
   When `fetchCloudBytes` aborts mid-stream due to `budget_exhausted` (e.g. after receiving 1.8 MB of a 10 MB file), should the 1.8 MB downloaded before abort be added to `summary.cloudBytesFetched`? (Recommended: Yes, to maintain accurate network accounting).
3. **OneDrive Delta Item Download URL vs On-Demand Fetch:**
   Microsoft Graph Delta API (`/me/drive/root/delta`) occasionally returns `@microsoft.graph.downloadUrl` directly during sync. However, because those URLs expire in ~1 hour, re-fetching `@microsoft.graph.downloadUrl` at media-pass time via `GET /me/drive/items/{id}` is necessary and sound. Is thumbnail rendition support for OneDrive images planned for PR 3 or deferred? (Plan Task 8 currently treats OneDrive as originals-only, which is consistent).

---

## 5. Summary Checklist of Required Plan Updates

- [ ] **Task 8 & 11:** Implement and wire `resolveCloudByteUrl` to handle Google Photos `mediaItems/{id}` re-resolution and OneDrive `@microsoft.graph.downloadUrl` retrieval with live OAuth tokens.
- [ ] **Task 11:** Add scratch-file deletion in `runMediaPass`'s `finally` block for cloud AV candidates.
- [ ] **Task 12:** Fix `parseMediaArgs` in `media-cmd.ts` to handle boolean flags (`--renditions`, `--originals`) without expecting a parameter value.
- [ ] **Task 9:** Add `https:` protocol validation for `byteUrl.kind === "provider"` in `fetchCloudBytes` and include the test case.
- [ ] **Task 6:** Update `safeFetchFollowing` to strip the `Authorization` header on cross-origin redirects.
- [ ] **Task 9:** Add pre-emptive check on `declared > deps.remainingBudget`.
- [ ] **Task 2:** Wrap `pruneOrphanedUnderstandings` statement execution in `dbStmtRun` for I14 compliance.
- [ ] **Task 13:** Add `docs/architecture.md` to the list of files updated for the I29 `sync` appender enumeration.

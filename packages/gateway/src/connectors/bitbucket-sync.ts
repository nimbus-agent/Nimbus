import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import { plainTextPreviewFromHtml } from "../string/html-plain-text.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "bitbucket";
const CURSOR_PREFIX = "nimbus-bbkt1:";
const API_ROOT = "https://api.bitbucket.org/2.0";

const MAX_REPOS_PER_SYNC = 3;
const MAX_PR_PAGES_PER_REPO = 6;
const MAX_REPO_LIST_PAGES_PER_SYNC = 1;

type BitbucketCursorV1 = {
  since: string;
  pendingRepos: string[];
  reposNext: string | null;
  activeRepo: string | null;
  prNext: string | null;
  repositoryPagesExhausted: boolean;
};

function encodeCursor(c: BitbucketCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): BitbucketCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const since = rec["since"];
  if (typeof since !== "string" || since === "") {
    return null;
  }
  const pendingRepos = rec["pendingRepos"];
  const pending: string[] = [];
  if (Array.isArray(pendingRepos)) {
    for (const x of pendingRepos) {
      if (typeof x === "string" && x.includes("/")) {
        pending.push(x);
      }
    }
  }
  const reposNext = rec["reposNext"];
  const activeRepo = rec["activeRepo"];
  const prNext = rec["prNext"];
  const repositoryPagesExhausted = rec["repositoryPagesExhausted"] === true;
  return {
    since,
    pendingRepos: pending,
    reposNext: typeof reposNext === "string" ? reposNext : null,
    activeRepo: typeof activeRepo === "string" ? activeRepo : null,
    prNext: typeof prNext === "string" ? prNext : null,
    repositoryPagesExhausted,
  };
}

function basicAuthHeader(user: string, pass: string): string {
  const b = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
  return `Basic ${b}`;
}

function htmlHref(rec: Record<string, unknown>): string | null {
  const links = asRecord(rec["links"]);
  if (links === undefined) {
    return null;
  }
  const html = asRecord(links["html"]);
  if (html === undefined) {
    return null;
  }
  return stringField(html, "href") ?? null;
}

function maxIso(a: string, b: string): string {
  return a > b ? a : b;
}

function normalizeBitbucketUserUuid(raw: string): string {
  return raw
    .replaceAll(/^\{|\}$/g, "")
    .trim()
    .toLowerCase();
}

function upsertFromPullRequest(
  ctx: SyncContext,
  repoFull: string,
  pr: Record<string, unknown>,
  now: number,
): void {
  const id = numberField(pr, "id");
  if (id === undefined) {
    return;
  }
  const title = stringField(pr, "title") ?? `PR #${String(id)}`;
  const desc = stringField(pr, "description") ?? "";
  const updatedOn = stringField(pr, "updated_on");
  const modified = updatedOn === undefined ? now : Date.parse(updatedOn);
  const state = stringField(pr, "state");
  const url = htmlHref(pr);
  const author = asRecord(pr["author"]);
  const displayName = author === undefined ? undefined : stringField(author, "display_name");
  const uuidRaw = author === undefined ? undefined : stringField(author, "uuid");
  const bbUuid =
    uuidRaw !== undefined && uuidRaw !== "" ? normalizeBitbucketUserUuid(uuidRaw) : undefined;
  const authorId =
    bbUuid !== undefined && bbUuid !== ""
      ? resolvePersonForSync(ctx.db, {
          bitbucketUuid: bbUuid,
          displayName: displayName ?? bbUuid,
        })
      : null;
  const meta: Record<string, unknown> = {
    id,
    repo: repoFull,
    state,
    author: displayName,
  };
  const externalId = `${repoFull}#${String(id)}`;
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "pr",
    externalId,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: plainTextPreviewFromHtml(desc, BODY_MAX_PROSE),
    url,
    canonicalUrl: url,
    modifiedAt: Number.isFinite(modified) ? modified : now,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

function parseRepositoryFullNames(body: unknown): string[] {
  const rec = asRecord(body);
  if (rec === undefined) {
    return [];
  }
  const values = rec["values"];
  if (!Array.isArray(values)) {
    return [];
  }
  const out: string[] = [];
  for (const v of values) {
    const r = asRecord(v);
    const fn = r === undefined ? undefined : stringField(r, "full_name");
    if (fn?.includes("/")) {
      out.push(fn);
    }
  }
  return out;
}

function stringFieldFromBody(body: unknown, key: string): string | undefined {
  const r = asRecord(body);
  return r === undefined ? undefined : stringField(r, key);
}

type BitbucketPrPageIngest = {
  maxUpdated: string;
  upsertedDelta: number;
  nextPrUrl: string | null;
};

function ingestBitbucketPullRequestPage(
  ctx: SyncContext,
  repoFull: string,
  json: unknown,
  now: number,
  priorMaxUpdated: string,
): BitbucketPrPageIngest {
  const rec = asRecord(json);
  const values = rec !== undefined && Array.isArray(rec["values"]) ? rec["values"] : [];
  let maxUpdated = priorMaxUpdated;
  let upsertedDelta = 0;
  for (const v of values) {
    const pr = asRecord(v);
    if (pr === undefined) {
      continue;
    }
    const uo = stringField(pr, "updated_on");
    if (uo !== undefined) {
      maxUpdated = maxIso(maxUpdated, uo);
    }
    upsertFromPullRequest(ctx, repoFull, pr, now);
    upsertedDelta += 1;
  }
  const next = stringFieldFromBody(json, "next");
  const nextPrUrl = next !== undefined && next !== "" ? next : null;
  return { maxUpdated, upsertedDelta, nextPrUrl };
}

export type BitbucketSyncableOptions = {
  ensureBitbucketMcpRunning: () => Promise<void>;
};

export function createBitbucketSyncable(options: BitbucketSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureBitbucketMcpRunning();
      const user = await readConnectorSecret(ctx.vault, "bitbucket", "username");
      const pass = await readConnectorSecret(ctx.vault, "bitbucket", "app_password");
      if (user === null || user === "" || pass === null || pass === "") {
        return syncNoopResult(cursor, t0);
      }
      const auth = basicAuthHeader(user, pass);

      const syncStartedIso = new Date().toISOString();
      const prev = decodeCursor(cursor);
      const nowMs = Date.now();
      const defaultSince = new Date(nowMs - initialSyncDepthDays * 86_400_000).toISOString();

      let state: BitbucketCursorV1 =
        prev === null
          ? {
              since: defaultSince,
              pendingRepos: [],
              reposNext: null,
              activeRepo: null,
              prNext: null,
              repositoryPagesExhausted: false,
            }
          : {
              ...prev,
              repositoryPagesExhausted: prev.repositoryPagesExhausted === true,
            };

      let upserted = 0;
      let bytesTransferred = 0;
      let maxUpdated = state.since;
      let reposScannedThisSync = 0;

      const syncResult = (nextState: BitbucketCursorV1, hasMore: boolean): SyncResult => ({
        cursor: encodeCursor(nextState),
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      });

      const drainPenalty = (res: Response, text: string): void => {
        if (res.status === 429) {
          const ra = res.headers.get("retry-after");
          let sec: number;
          if (ra === null) {
            sec = 60;
          } else {
            sec = Number.parseInt(ra, 10);
          }
          const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000;
          ctx.rateLimiter.penalise("bitbucket", ms);
          throw new Error(`Bitbucket 429: ${text.slice(0, 200)}`);
        }
      };

      async function fetchJson(
        url: string,
      ): Promise<{ res: Response; text: string; json: unknown }> {
        await ctx.rateLimiter.acquire("bitbucket");
        const res = await fetch(url, {
          headers: { Authorization: auth, Accept: "application/json" },
        });
        const text = await res.text();
        bytesTransferred += text.length;
        drainPenalty(res, text);
        if (!res.ok) {
          throw new Error(`Bitbucket ${String(res.status)}: ${text.slice(0, 200)}`);
        }
        let json: unknown;
        try {
          json = JSON.parse(text) as unknown;
        } catch {
          throw new Error("Bitbucket: invalid JSON");
        }
        return { res, text, json };
      }

      async function resumeActiveRepoPagination(): Promise<SyncResult | null> {
        if (state.activeRepo === null || state.prNext === null) {
          return null;
        }
        let prUrl: string | null = state.prNext;
        let prPages = 0;
        const active = state.activeRepo;
        while (prUrl !== null && prPages < MAX_PR_PAGES_PER_REPO) {
          const { json } = await fetchJson(prUrl);
          prPages += 1;
          const now = Date.now();
          const page = ingestBitbucketPullRequestPage(ctx, active, json, now, maxUpdated);
          maxUpdated = page.maxUpdated;
          upserted += page.upsertedDelta;
          prUrl = page.nextPrUrl;
        }
        state = {
          ...state,
          prNext: prUrl,
          activeRepo: prUrl === null ? null : active,
        };
        if (state.prNext !== null || state.activeRepo !== null) {
          return syncResult(state, true);
        }
        return null;
      }

      async function refillPendingReposFromWorkspace(): Promise<void> {
        let repoListPagesFetched = 0;
        while (
          state.pendingRepos.length === 0 &&
          repoListPagesFetched < MAX_REPO_LIST_PAGES_PER_SYNC
        ) {
          if (state.reposNext === null && state.repositoryPagesExhausted) {
            break;
          }
          const listUrl =
            state.reposNext ??
            `${API_ROOT}/repositories?${new URLSearchParams({ role: "member", pagelen: "30" })}`;
          const { json } = await fetchJson(listUrl);
          repoListPagesFetched += 1;
          const names = parseRepositoryFullNames(json);
          const nextLink = stringFieldFromBody(json, "next") ?? null;
          state = {
            ...state,
            pendingRepos: [...state.pendingRepos, ...names],
            reposNext: nextLink,
            repositoryPagesExhausted: nextLink === null,
          };
          if (nextLink === null) {
            break;
          }
        }
      }

      async function scanPullRequestsForPendingRepos(): Promise<SyncResult | null> {
        while (reposScannedThisSync < MAX_REPOS_PER_SYNC && state.pendingRepos.length > 0) {
          const repoFull = state.pendingRepos.shift();
          if (repoFull === undefined) {
            break;
          }
          reposScannedThisSync += 1;
          const segments = repoFull.split("/");
          const workspace = segments[0] ?? "";
          const repoSlug = segments.slice(1).join("/");
          if (workspace === "" || repoSlug === "") {
            continue;
          }
          const q = `updated_on>${state.since}`;
          const qs = new URLSearchParams();
          qs.set("pagelen", "50");
          qs.set("sort", "-updated_on");
          qs.set("q", q);
          const firstUrl = `${API_ROOT}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests?${qs.toString()}`;

          let prUrl: string | null = firstUrl;
          let prPages = 0;
          while (prUrl !== null && prPages < MAX_PR_PAGES_PER_REPO) {
            const { json } = await fetchJson(prUrl);
            prPages += 1;
            const now = Date.now();
            const page = ingestBitbucketPullRequestPage(ctx, repoFull, json, now, maxUpdated);
            maxUpdated = page.maxUpdated;
            upserted += page.upsertedDelta;
            prUrl = page.nextPrUrl;
            if (prUrl !== null && prPages >= MAX_PR_PAGES_PER_REPO) {
              state = {
                since: state.since,
                pendingRepos: state.pendingRepos,
                reposNext: state.reposNext,
                activeRepo: repoFull,
                prNext: prUrl,
                repositoryPagesExhausted: state.repositoryPagesExhausted,
              };
              return syncResult(state, true);
            }
          }
        }
        return null;
      }

      const resumed = await resumeActiveRepoPagination();
      if (resumed !== null) {
        return resumed;
      }

      await refillPendingReposFromWorkspace();

      const mid = await scanPullRequestsForPendingRepos();
      if (mid !== null) {
        return mid;
      }

      const cycleIncomplete =
        state.pendingRepos.length > 0 ||
        state.reposNext !== null ||
        !state.repositoryPagesExhausted;
      const advancedSince = maxIso(
        state.since,
        maxUpdated > state.since ? maxUpdated : syncStartedIso,
      );

      if (cycleIncomplete) {
        state = {
          since: state.since,
          pendingRepos: state.pendingRepos,
          reposNext: state.reposNext,
          activeRepo: null,
          prNext: null,
          repositoryPagesExhausted: state.repositoryPagesExhausted,
        };
        return syncResult(state, true);
      }

      state = {
        since: advancedSince,
        pendingRepos: [],
        reposNext: null,
        activeRepo: null,
        prNext: null,
        repositoryPagesExhausted: false,
      };

      return syncResult(state, false);
    },
  };
}

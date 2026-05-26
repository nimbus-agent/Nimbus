import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapStripeInvoiceToItem } from "./stripe-invoice-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "stripe";
const CURSOR_PREFIX = "nimbus-stripe1:";
const BASE = "https://api.stripe.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type StripeCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies StripeCursorV1);
}

export type StripeSyncableOptions = {
  ensureStripeMcpRunning: () => Promise<void>;
};

interface StripeCreds {
  readonly apiKey: string;
}

/**
 * `stripe.api_key` is required. Stripe's API host is a fixed SaaS host
 * (`api.stripe.com`) — there is no host override key. The connector no-ops
 * unless the key is non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<StripeCreds | null> {
  const apiKey = (await readConnectorSecret(ctx.vault, "stripe", "api_key"))?.trim() ?? "";
  if (apiKey === "") {
    return null;
  }
  return { apiKey };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

/**
 * Build `/v1/invoices?limit=100`, optionally with a `starting_after` cursor
 * (the id of the last invoice from the previous page — Stripe's forward cursor).
 */
function invoicesPath(startingAfter: string | null): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (startingAfter !== null) {
    params.set("starting_after", startingAfter);
  }
  return `/v1/invoices?${params.toString()}`;
}

async function stripeGet(
  ctx: SyncContext,
  creds: StripeCreds,
  path: string,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // Stripe uses a standard `Authorization: Bearer <secret-key>` header
  // (the key starts `sk_live_` / `sk_test_` — never logged).
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "stripe GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

/**
 * `GET /v1/invoices` returns the Stripe list envelope
 * `{ object: "list", data: [...], has_more: boolean }`. Extract the data array
 * and the `has_more` flag defensively — a missing/malformed envelope yields an
 * empty page with `hasMore: false` so the walk terminates.
 */
function extractInvoices(parsed: unknown): { invoices: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { invoices: [], hasMore: false };
  }
  const data = root["data"];
  const invoices = Array.isArray(data) ? data : [];
  return { invoices, hasMore: root["has_more"] === true };
}

function upsertInvoices(ctx: SyncContext, invoices: readonly unknown[], now: number): number {
  let upserted = 0;
  for (const inv of invoices) {
    const mapped = mapStripeInvoiceToItem(inv, { syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

/** The forward cursor for the next page is the id of the last invoice on this page. */
function lastInvoiceId(invoices: readonly unknown[]): string | null {
  const last = invoices[invoices.length - 1];
  const row = asRecord(last);
  if (row === undefined) {
    return null;
  }
  const id = stringField(row, "id");
  return id === undefined || id === "" ? null : id;
}

export function createStripeSyncable(options: StripeSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureStripeMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let startingAfter: string | null = null;

      // The first invoices page is the gating call: a FIRST-page http/parse
      // error maps to the pass-cursor-empty result. Later-page errors just
      // break, preserving whatever was already collected. Stripe cursor-
      // paginates: pass `starting_after=<last id>` and follow `has_more` until
      // it is false (or the MAX_PAGES cap stops the walk).
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const outcome = await stripeGet(ctx, creds, invoicesPath(startingAfter));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          if (page === 1) {
            return outcome.kind === "http_error"
              ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
              : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }

        const { invoices, hasMore } = extractInvoices(outcome.parsed);
        totalUpserted += upsertInvoices(ctx, invoices, now);

        const next = lastInvoiceId(invoices);
        if (!hasMore || next === null) {
          break;
        }
        startingAfter = next;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}

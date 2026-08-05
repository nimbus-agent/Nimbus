import { describe, expect, test } from "bun:test";

import type { SyncContext } from "../../sync/types.ts";
import { type ImapLikeFetchOutcome, parsePortSecret, runImapLikeSync } from "./imap-sync-core.ts";
import type { SyncUpsertRow } from "./paginated-sync.ts";

describe("parsePortSecret", () => {
  test("returns fallback for empty / whitespace / nullish", () => {
    expect(parsePortSecret(null, 993)).toBe(993);
    expect(parsePortSecret(undefined, 993)).toBe(993);
    expect(parsePortSecret("", 993)).toBe(993);
    expect(parsePortSecret("   ", 993)).toBe(993);
  });
  test("parses a valid port and truncates floats", () => {
    expect(parsePortSecret("1143", 993)).toBe(1143);
    expect(parsePortSecret("993.9", 465)).toBe(993);
  });
  test("returns fallback for out-of-range / non-numeric", () => {
    expect(parsePortSecret("0", 993)).toBe(993);
    expect(parsePortSecret("65536", 993)).toBe(993);
    expect(parsePortSecret("-1", 993)).toBe(993);
    expect(parsePortSecret("nope", 993)).toBe(993);
  });
});

type Row = SyncUpsertRow;
const ROW = { service: "imap", type: "email", externalId: "x" } as unknown as Row;

function fakeCtx(): { ctx: SyncContext; warns: unknown[]; acquired: string[] } {
  const warns: unknown[] = [];
  const acquired: string[] = [];
  const ctx = {
    logger: { warn: (obj: unknown, _msg?: string) => warns.push(obj) },
    rateLimiter: {
      acquire: async (p: string) => {
        acquired.push(p);
      },
    },
    // `depth` is a REQUIRED field of `SyncContext`; the `as unknown as` cast
    // below hides its absence, and this file is the email core the Gmail /
    // Outlook body work extends. Supply it explicitly so the fixture matches
    // the depth a real run resolves for an unconfigured connector.
    depth: "full",
  } as unknown as SyncContext;
  return { ctx, warns, acquired };
}

const BASE = {
  serviceId: "imap" as const,
  ensureRunning: async () => {},
  maxMessages: 200,
  pass1Cursor: () => "PASS1",
};

describe("runImapLikeSync", () => {
  test("loadConfig → null yields a noop preserving the cursor (no rate-limit)", async () => {
    const { ctx, acquired } = fakeCtx();
    const res = await runImapLikeSync(ctx, "prev", {
      ...BASE,
      loadConfig: async () => null,
      fetchMessages: async () => ({ ok: true, messages: [] }) as ImapLikeFetchOutcome<unknown>,
      mapMessage: () => ROW,
    });
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(acquired).toHaveLength(0);
  });

  test("rate-limits before fetching, and an empty success upserts nothing", async () => {
    const { ctx, acquired } = fakeCtx();
    const res = await runImapLikeSync(ctx, null, {
      ...BASE,
      loadConfig: async () => ({}),
      fetchMessages: async () => ({ ok: true, messages: [] }),
      mapMessage: () => ROW,
    });
    expect(acquired).toEqual(["imap"]);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("PASS1");
  });

  test("a thrown fetch degrades to a transient result preserving the cursor", async () => {
    const { ctx, warns } = fakeCtx();
    const res = await runImapLikeSync(ctx, "keep", {
      ...BASE,
      loadConfig: async () => ({}),
      fetchMessages: async () => {
        throw new Error("boom");
      },
      mapMessage: () => ROW,
    });
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("keep");
    expect(warns).toHaveLength(1);
  });

  test("an {ok:false} outcome degrades to a transient result (cursor falls back to pass1)", async () => {
    const { ctx, warns } = fakeCtx();
    const res = await runImapLikeSync(ctx, null, {
      ...BASE,
      loadConfig: async () => ({}),
      fetchMessages: async () => ({ ok: false, error: "conn refused" }),
      mapMessage: () => ROW,
    });
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("PASS1");
    expect(warns).toHaveLength(1);
  });
});

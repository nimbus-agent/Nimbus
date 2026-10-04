/**
 * `buildMediaPassDeps` arms `build-media-pass-deps.test.ts` does not reach:
 *  - the granted REMOTE understander's two last steps — refusing an empty image before any
 *    request, and actually describing a granted image end to end (ledger row FIRST, then the
 *    vendor call, then the trimmed caption back);
 *  - the LOCAL VLM built with an injected `vlmFetch`;
 *  - `withTranscribeTimeout` wrapping a non-Error rejection; and the wired `nowMs` clock.
 *
 * Hermetic throughout, and FAIL-CLOSED on the network: every understander case swaps
 * `globalThis.fetch` (the remote adapter is built with no fetch seam of its own — `buildRemoteFor`
 * passes none — and the local one falls back to the global without `vlmFetch`) for a stub that
 * answers only the one URL the case expects and throws on anything else, so even a regression
 * cannot turn this file into a real outbound request. The global is restored in `finally`.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildMediaPassDeps, withTranscribeTimeout } from "./build-media-pass-deps.ts";
import { createGrant } from "./media-grant-store.ts";
import type { MediaCandidate } from "./media-types.ts";
import { UnsupportedImageFormatError } from "./media-types.ts";
import { DEFAULT_VLM_BASE_URL, DEFAULT_VLM_MODEL } from "./multimodal-config.ts";
import { IMAGE_CAPTION_PROMPT } from "./vlm/caption-prompts.ts";

/** A PNG signature plus a few body bytes — enough for the magic-byte sniff, nothing more. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function migratedDb(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

function imageCandidate(): MediaCandidate {
  return {
    itemId: "google_drive:img-1",
    service: "google_drive",
    externalId: "img-1",
    type: "media_image",
    title: "diagram.png",
    url: null,
    modality: "image",
    sourcePath: null,
    sourceMime: "image/png",
    sourceBytes: PNG.byteLength,
  };
}

function vaultWith(entries: Record<string, string>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    listKeys: () => Promise.resolve(Object.keys(entries)),
  };
}

type LedgerRow = {
  source_type: string;
  source_id: string | null;
  destination: string;
  method: string;
  payload_summary: string;
  hitl_status: string;
  result_status: string;
};

function ledger(db: Database): LedgerRow[] {
  return db
    .query(
      `SELECT source_type, source_id, destination, method, payload_summary, hitl_status, result_status
         FROM egress_ledger ORDER BY id`,
    )
    .all() as LedgerRow[];
}

type SentRequest = { url: string; init: RequestInit | undefined };

/**
 * Replaces `globalThis.fetch` with a stub that answers `routes` and REJECTS everything else,
 * recording every attempt either way. Returns the record and the restorer.
 */
function stubNetwork(routes: Record<string, (init: RequestInit | undefined) => Response>): {
  sent: SentRequest[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const sent: SentRequest[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    const route = routes[url];
    return route === undefined
      ? Promise.reject(new Error(`network forbidden in this test: ${url}`))
      : Promise.resolve(route(init));
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** Deps for one ANTHROPIC-granted image, with the vendor key in the vault. */
function grantedRemote(db: Database) {
  const candidate = imageCandidate();
  createGrant(db, {
    itemId: candidate.itemId,
    modality: "image",
    modelVendor: "anthropic",
    nowMs: 1,
  });
  const deps = buildMediaPassDeps({
    db,
    roots: [],
    enabled: true,
    capabilityDisabled: false,
    scratchDir: "/scratch",
    remoteVlm: "anthropic",
    remoteVlmVendorEnabled: true,
    vault: vaultWith({ "anthropic.api_key": "sk-c14-test-key" }),
  });
  const understander = deps.gate.remoteFor?.(candidate);
  if (understander === undefined) throw new Error("expected a granted remote understander");
  return understander;
}

describe("the granted remote understander", () => {
  test("refuses an EMPTY image before any request — and so appends no ledger row", async () => {
    const db = migratedDb();
    // Installed BEFORE the deps are built: the remote adapter captures `fetch` at construction.
    const net = stubNetwork({});
    try {
      const understander = grantedRemote(db);
      let caught: unknown;
      try {
        // A declared PNG type would otherwise resolve a MIME for zero bytes and buy a paid,
        // ledgered request for nothing.
        await understander.understand({
          kind: "bytes",
          bytes: new Uint8Array(0),
          mime: "image/png",
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("image source is empty");
      expect(caught).not.toBeInstanceOf(UnsupportedImageFormatError);
      expect(net.sent).toEqual([]);
      expect(ledger(db)).toEqual([]);
    } finally {
      net.restore();
      db.close();
    }
  });

  test("describes a granted image: ledger row first, then exactly one vendor call, then the trimmed caption", async () => {
    const db = migratedDb();
    const ledgerRowsAtSend: number[] = [];
    // Installed BEFORE the deps are built: the remote adapter captures `fetch` at construction.
    const net = stubNetwork({
      [ANTHROPIC_URL]: () => {
        ledgerRowsAtSend.push(ledger(db).length);
        return Response.json({
          content: [{ type: "text", text: "  A labelled pipeline diagram.  " }],
        });
      },
    });
    try {
      const understander = grantedRemote(db);
      expect(understander.isLocal).toBe(false);
      const result = await understander.understand({ kind: "bytes", bytes: PNG, mime: null });
      expect(result).toEqual({ text: "A labelled pipeline diagram." });

      expect(net.sent.map((r) => r.url)).toEqual([ANTHROPIC_URL]);
      // Ledger THEN act (I29/I37): the row already existed when the request was sent.
      expect(ledgerRowsAtSend).toEqual([1]);
      const headers = net.sent[0]?.init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("sk-c14-test-key");
      const body = JSON.parse(String(net.sent[0]?.init?.body)) as {
        model: string;
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      expect(body.model).toBe("claude-sonnet-5");
      expect(body.messages[0]?.content).toEqual([
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: Buffer.from(PNG).toString("base64"),
          },
        },
        { type: "text", text: IMAGE_CAPTION_PROMPT },
      ]);

      const rows = ledger(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source_type: "model",
        source_id: "claude-sonnet-5",
        destination: "anthropic",
        method: "multimodal.vlm.image",
        hitl_status: "not_required",
        result_status: "authorized",
      });
      // The byte COUNT and the model — never the bytes, the prompt, or the key.
      const summary = rows[0]?.payload_summary ?? "";
      expect(JSON.parse(summary)).toEqual({ model: "claude-sonnet-5", imageBytes: PNG.byteLength });
      expect(summary).not.toContain(Buffer.from(PNG).toString("base64"));
      expect(summary).not.toContain("sk-c14-test-key");
    } finally {
      net.restore();
      db.close();
    }
  });
});

describe("the local VLM", () => {
  test("an injected vlmFetch carries the local caption call, and a LOCAL describe appends no ledger row", async () => {
    const db = migratedDb();
    // The GLOBAL fetch is blocked too: the caption must arrive through `vlmFetch` and nothing else.
    const net = stubNetwork({});
    try {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const deps = buildMediaPassDeps({
        db,
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
        vlmFetch: (input, init) => {
          calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
          return Promise.resolve(Response.json({ response: " Two boxes and an arrow. " }));
        },
      });
      const understander = deps.gate.understanderFor("image", imageCandidate());
      expect(understander?.isLocal).toBe(true);
      const result = await understander?.understand({ kind: "bytes", bytes: PNG, mime: null });
      expect(result).toEqual({ text: "Two boxes and an arrow." });
      expect(calls).toEqual([
        {
          url: `${DEFAULT_VLM_BASE_URL}/api/generate`,
          body: {
            model: DEFAULT_VLM_MODEL,
            prompt: IMAGE_CAPTION_PROMPT,
            images: [Buffer.from(PNG).toString("base64")],
            stream: false,
          },
        },
      ]);
      expect(net.sent).toEqual([]);
      expect(ledger(db)).toEqual([]);
    } finally {
      net.restore();
      db.close();
    }
  });
});

describe("small wiring arms", () => {
  test("withTranscribeTimeout turns a non-Error rejection into an Error carrying its text", async () => {
    const bounded = withTranscribeTimeout(
      () => Promise.reject("whisper: model file missing"),
      5_000,
    );
    let caught: unknown;
    try {
      await bounded("/scratch/a.wav");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("whisper: model file missing");
    expect((caught as Error).message).not.toContain("timed out");
  });

  test("nowMs is wired to the wall clock", () => {
    const db = migratedDb();
    try {
      const deps = buildMediaPassDeps({
        db,
        roots: [],
        enabled: true,
        capabilityDisabled: false,
        scratchDir: "/scratch",
      });
      const before = Date.now();
      const now = deps.nowMs();
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(Date.now());
    } finally {
      db.close();
    }
  });
});

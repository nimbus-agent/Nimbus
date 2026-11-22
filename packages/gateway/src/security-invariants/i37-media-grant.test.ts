import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { listEgress } from "../egress/egress-verify.ts";
import { wrapLedgeredVlm } from "../egress/vlm-egress.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { understandArtifact } from "../multimodal/media-gate.ts";
import { createGrant, MediaGrantRefusedError } from "../multimodal/media-grant-store.ts";
import type { VlmProvider } from "../multimodal/vlm/vlm-types.ts";

describe("I37 — a media body reaches a non-local model only under a grant", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    return db;
  }

  function countEgress(db: Database, sourceType: string): number {
    return listEgress(db, {}).filter((r) => r.sourceType === sourceType).length;
  }

  function egressRows(db: Database) {
    return listEgress(db, {});
  }

  function imageCandidate() {
    return {
      itemId: "onedrive:img-1",
      service: "onedrive",
      externalId: "img-1",
      type: "media_image" as const,
      title: "a.png",
      url: null,
      modality: "image" as const,
      sourcePath: null,
      sourceMime: "image/png",
      sourceBytes: 10,
    };
  }

  function imageSource() {
    return { kind: "bytes" as const, bytes: new Uint8Array([1]), mime: "image/png" };
  }

  function fakeRemoteVlm(): VlmProvider {
    return {
      providerId: "openai",
      isLocal: false,
      model: "gpt-5",
      isAvailable: async () => true,
      describe: async () => ({ text: "a caption" }),
    };
  }

  /**
   * Negative control FIRST: without it, "zero rows" would pass for any reason at all.
   *
   * MUST be capable of failing, which the original version of this test was not: `db` was
   * constructed and never touched by anything the gate could reach — `MediaGateDeps` carries no
   * `db` at all, and the fake `understanderFor` result here appended nothing even if `understand`
   * ran — so `countEgress(db, "model") === 0` passed no matter what the gate did with it. The fix
   * is to route the fake remote understander's `understand` through a REAL `wrapLedgeredVlm`
   * instance, the exact appender production wires in `build-media-pass-deps.ts`'s `buildRemoteFor`.
   * Now the assertion is load-bearing: had the gate let this candidate through to `understand()`,
   * this WOULD be 1 (the isolation test below drives the identical shape of wrapped provider to
   * exactly one row) — a refusal that still appends nothing is the property I37 promises.
   */
  test("no grant: the gate refuses, contacts nothing, and appends NO egress row it would have appended if reached", async () => {
    const db = freshDb();
    let contacted = false;
    const remoteProvider = wrapLedgeredVlm(db, {
      providerId: "openai",
      isLocal: false,
      model: "gpt-5",
      isAvailable: async () => true,
      describe: async () => {
        contacted = true;
        return { text: "leaked" };
      },
    });
    const res = await understandArtifact(imageCandidate(), imageSource(), {
      enabled: true,
      capabilityDisabled: false,
      understanderFor: () => ({
        isLocal: false,
        model: remoteProvider.model,
        isAvailable: () => remoteProvider.isAvailable(),
        understand: () =>
          remoteProvider.describe({
            bytes: new Uint8Array([1]),
            prompt: "p",
            mimeType: "image/png",
          }),
      }),
      remoteFor: () => undefined, // no grant
      gpu: { acquire: async () => () => undefined, touch: () => undefined },
    });
    expect(res).toEqual({ ok: false, reason: "no_remote_grant" });
    expect(contacted).toBe(false);
    expect(countEgress(db, "model")).toBe(0);
  });

  /**
   * Finding 2 of the 2026-09-05 whole-branch review: `remote-vlm-shared.ts`'s `isAvailable` is
   * Vault key PRESENCE only and makes no request, so probing it is free. Before the fix,
   * `media-gate.ts` skipped that probe for the remote arm entirely — a keyless (never configured,
   * or rotated out of the Vault) vendor reached `chosen.understand()` unconditionally, which is
   * exactly where `wrapLedgeredVlm` appends its row BEFORE delegating. The ledger recorded a
   * request that never left the machine, on every pass, for as long as the grant stood.
   */
  test("grant present but the vendor has NO key in the Vault: the gate refuses BEFORE contact and appends NO egress row", async () => {
    const db = freshDb();
    let contacted = false;
    const remoteProvider = wrapLedgeredVlm(db, {
      providerId: "openai",
      isLocal: false,
      model: "gpt-5",
      isAvailable: async () => false, // key-presence check fails: never set, or rotated out
      describe: async () => {
        contacted = true;
        return { text: "leaked" };
      },
    });
    const remoteUnderstander = {
      isLocal: false,
      model: remoteProvider.model,
      isAvailable: () => remoteProvider.isAvailable(),
      understand: () =>
        remoteProvider.describe({ bytes: new Uint8Array([1]), prompt: "p", mimeType: "image/png" }),
    };
    const res = await understandArtifact(imageCandidate(), imageSource(), {
      enabled: true,
      capabilityDisabled: false,
      understanderFor: () => remoteUnderstander,
      remoteFor: () => remoteUnderstander, // configured AND granted -- only the key is missing
      gpu: { acquire: async () => () => undefined, touch: () => undefined },
    });
    expect(res).toEqual({ ok: false, reason: "not_configured" });
    expect(contacted).toBe(false);
    expect(countEgress(db, "model")).toBe(0);
  });

  /**
   * NOT a grant/gate test despite its former name ("with a grant: ...") — there is no grant here
   * and no call to `understandArtifact`/media-gate.ts at all. This drives `wrapLedgeredVlm`'s
   * appender directly against `provider.describe()`, in isolation, proving the appender's own
   * BEFORE-ordering property (the row exists by the time the request runs). The gate's actual
   * grant enforcement — and the keyless-vendor fix — are what the two tests above prove.
   */
  test("wrapLedgeredVlm in isolation (no grant, no gate): describe happens and appends exactly one model row BEFORE it", async () => {
    const db = freshDb();
    const order: string[] = [];
    const provider = wrapLedgeredVlm(db, {
      providerId: "openai",
      isLocal: false,
      model: "gpt-5",
      isAvailable: async () => true,
      describe: async () => {
        // The row must already exist by the time the request runs: a window with zero rows must
        // mean nothing left, never that something left unrecorded.
        expect(countEgress(db, "model")).toBe(1);
        order.push("request");
        return { text: "a caption" };
      },
    });
    await provider.describe({ bytes: new Uint8Array([1]), prompt: "p", mimeType: "image/png" });
    expect(order).toEqual(["request"]);
    expect(countEgress(db, "model")).toBe(1);
  });

  test("payload_summary carries the model and a byte COUNT, never the bytes or the prompt", async () => {
    const db = freshDb();
    const provider = wrapLedgeredVlm(db, fakeRemoteVlm());
    await provider.describe({
      bytes: new Uint8Array([1, 2, 3, 4]),
      prompt: "SECRET PROMPT",
      mimeType: "image/png",
    });
    const summary = egressRows(db)[0]?.payloadSummary ?? "";
    // Parses the field rather than substring-matching the digit "4" -- `toContain("4")` would pass
    // for `imageBytes: 14` or `imageBytes: 42` just as readily, which is not what this test claims
    // to prove.
    expect(JSON.parse(summary)).toMatchObject({ model: "gpt-5", imageBytes: 4 });
    expect(summary).not.toContain("SECRET PROMPT");
  });

  test("a local provider is returned UNCHANGED and appends nothing (I34-derived)", () => {
    const db = freshDb();
    const local = { ...fakeRemoteVlm(), isLocal: true };
    expect(wrapLedgeredVlm(db, local)).toBe(local);
  });

  test("the grant store REFUSES an av grant, so no av artifact can reach a remote model", () => {
    const db = freshDb();
    expect(() =>
      createGrant(db, { itemId: "i", modality: "av", modelVendor: "openai", nowMs: 1 }),
    ).toThrow(MediaGrantRefusedError);
  });
});

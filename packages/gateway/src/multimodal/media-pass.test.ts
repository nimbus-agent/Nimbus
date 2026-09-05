import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

import { findCandidates } from "./media-discovery.ts";
import type { MediaCloudDeps, MediaPassDeps } from "./media-pass.ts";
import { priceRun, runMediaPass } from "./media-pass.ts";
import { readCursor, writeCursor } from "./media-pass-state.ts";
import type { MediaCandidate } from "./media-types.ts";
import { understandingExternalId } from "./understanding-item.ts";

/**
 * Host-EXACT, never a substring.
 *
 * `url.includes("photoslibrary.googleapis.com")` would also match
 * `https://evil.example/?x=photoslibrary.googleapis.com` — the precise host confusion the cloud
 * arm's credential rule exists to prevent. A fake that dispatches on a substring, or an assertion
 * that accepts one, is weaker than the code it guards: it would keep passing if the resolver
 * started sending its bearer to the wrong host. CodeQL flags the pattern
 * (`js/incomplete-url-substring-sanitization`) and is right to.
 */
function isHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

let db: Database;
let root: string;

function addMediaFile(name: string): string {
  const p = join(root, name);
  writeFileSync(p, "x");
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "media_av",
    externalId: p,
    title: name,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
  });
  return p;
}

/**
 * Seeds a Drive-style cloud item: no `path` in metadata (so `sourcePath` resolves null, the cloud
 * arm's own trigger), and `mimeType` set so `google_drive`'s mime-keyed discovery arm admits it.
 * `sizeBytes` omitted means `mediaSourceBytes` returns null — `priceRun` must report that as
 * UNKNOWN, never as free.
 */
function addDriveItem(
  externalId: string,
  opts: { readonly modality?: "image" | "av"; readonly sizeBytes?: number } = {},
): void {
  const modality = opts.modality ?? "image";
  upsertIndexedItem(db, {
    service: "google_drive",
    type: "file",
    externalId,
    title: `${externalId}`,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: {
      mimeType: modality === "image" ? "image/png" : "video/mp4",
      // Drive's `size` is a STRING (the v3 API serialises int64 as one) — see
      // `media-source-registry.ts`'s `SOURCE_BYTES_KEY`.
      ...(opts.sizeBytes === undefined ? {} : { size: String(opts.sizeBytes) }),
    },
  });
}

/** google_photos never indexes a byte size at all — there is no `sizeBytes` option here. */
function addPhotosItem(
  externalId: string,
  opts: { readonly modality?: "image" | "av" } = {},
): void {
  const modality = opts.modality ?? "image";
  upsertIndexedItem(db, {
    service: "google_photos",
    type: "photo",
    externalId,
    title: `${externalId}`,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { mimeType: modality === "image" ? "image/jpeg" : "video/mp4" },
  });
}

/** A harmless default: bearerFor/fetchFn are never invoked by a purely-local candidate set. */
function cloudDeps(over: Partial<MediaCloudDeps> = {}): MediaCloudDeps {
  return {
    bearerFor: async () => "test-token",
    fetchFn: async () => new Response("stub-body"),
    appendEgress: () => ({ rowHash: "h" }),
    sleep: async () => undefined,
    ...over,
  };
}

function deps(over: Partial<MediaPassDeps> = {}): MediaPassDeps {
  return {
    db,
    roots: [root],
    limit: 100,
    maxBytes: 1_000_000,
    nowMs: () => 5000,
    passId: "default",
    gate: {
      enabled: true,
      capabilityDisabled: false,
      understanderFor: () => ({
        isLocal: true,
        model: "whisper-base",
        isAvailable: async () => true,
        understand: async () => ({ text: "transcript" }),
      }),
      gpu: { acquire: async () => () => undefined, touch: () => undefined },
    },
    // A local-only pass never reaches the cloud arm, so this budget is deliberately generous
    // (never the trigger) unless a test overrides it — the cloud tests below always do.
    fetchBudgetBytes: Number.MAX_SAFE_INTEGER,
    preferRenditions: false,
    cloudBytes: cloudDeps(),
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  root = mkdtempSync(join(tmpdir(), "nimbus-pass-"));
});

describe("runMediaPass", () => {
  test("understands each candidate and writes a derived item", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.understood).toBe(1);

    const rows = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .all();
    expect(rows).toHaveLength(1);
    // A local candidate always understands from "the original file" — the rendition sentence
    // (ordering pinned on its own in understanding-item.test.ts) LEADS the model's own text.
    expect(rows[0]?.body ?? "").toContain("transcript");
    expect(rows[0]?.body ?? "").toContain("Understood from the original file.");
  });

  test("is idempotent — a second run understands nothing new", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const second = await runMediaPass(deps({ passId: "second" }));
    expect(second.understood).toBe(0);
  });

  test("honours the limit budget", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    expect((await runMediaPass(deps({ limit: 2 }))).understood).toBe(2);
  });

  test("a per-artifact failure does NOT abort the pass", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    let calls = 0;
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          understanderFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => {
              calls += 1;
              if (calls === 1) throw new Error("first one fails");
              return { text: "ok" };
            },
          }),
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(1);
    expect(summary.skippedByReason["transcribe_failed"]).toBe(1);
  });

  test("reports skips BY REASON — a bare success line is the disclosure failure", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({ roots: [] }), // nothing is inside a configured root
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["path_outside_roots"]).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  test("refuses everything when the capability is disabled", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: false,
          capabilityDisabled: false,
          understanderFor: () => undefined,
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
  });

  test("advances the cursor so an interrupted pass resumes", async () => {
    addMediaFile("a.mp4");
    // A second candidate the limit does not reach: this run is genuinely INTERRUPTED (more work
    // remains), distinct from a drained run — which, correctly, clears the cursor instead (see
    // "runMediaPass — cursor resume" below). limit:1 is what keeps candidates.length < limit
    // false, so the cursor this run wrote is not cleared out from under the assertion.
    addMediaFile("zz-remainder.mp4");
    const summary = await runMediaPass(deps({ limit: 1 }));
    expect(summary.lastItemId).not.toBeNull();
    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("advances the cursor on a SKIP, so a resumed pass does not restart on the same artifact", async () => {
    addMediaFile("unreadable.mp4");
    // A second candidate + limit:1 keeps this run from draining the queue (see above) — the
    // property under test is the mid-run advance, not the drain-clear this same run would
    // otherwise also trigger.
    addMediaFile("zz-remainder.mp4");
    // roots: [] means every candidate refuses with path_outside_roots before the gate is reached.
    const summary = await runMediaPass(deps({ roots: [], limit: 1 }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.lastItemId).not.toBeNull();

    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("advances the cursor on a gate-refusal SKIP too — the second skip branch", async () => {
    addMediaFile("unreadable.mp4");
    // Same reason as the two tests above: a second candidate + limit:1 keeps this an interrupted
    // (not drained) run.
    addMediaFile("zz-remainder.mp4");
    // capability disabled means resolveLocalMediaPath succeeds but understandArtifact refuses —
    // the OTHER skip branch, distinct from path_outside_roots above.
    const summary = await runMediaPass(
      deps({
        limit: 1,
        gate: {
          enabled: false,
          capabilityDisabled: false,
          understanderFor: () => undefined,
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
    expect(summary.lastItemId).not.toBeNull();

    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("appends ZERO egress rows — this PR makes no outbound request", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n;
    expect(n).toBe(0);
  });

  test("a long transcript is stored in full, not truncated to the 512-char preview cap", async () => {
    addMediaFile("long.mp4");
    const long = "x".repeat(3_000);
    await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          understanderFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => ({ text: long }),
          }),
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    const row = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .get();
    // The rendition sentence LEADS the model's text, so the exact total length is no longer
    // 3,000 — the property this test pins is that the 3,000-char transcript survived uncapped
    // (as the body's TAIL, since it is well under BODY_MAX_PROSE once the short leading sentence
    // is added — the "survives an actual cap" case is pinned separately, below).
    expect(row?.body?.endsWith(long)).toBe(true);
    expect((row?.body?.length ?? 0) > 3_000).toBe(true);
  });

  test("the rendition sentence survives a body clamped at BODY_MAX_PROSE — a ~45-minute recording is ordinary here", async () => {
    addMediaFile("verylong.mp4");
    // Comfortably over BODY_MAX_PROSE (16,384) once the leading sentence is added too, so the
    // clamp genuinely bites and truncates this transcript's TAIL — proving the property under
    // test is "the sentence survives a REAL cap", not merely "the sentence exists on a short body".
    const huge = "y".repeat(20_000);
    await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          understanderFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => ({ text: huge }),
          }),
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    const row = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .get();
    const body = row?.body ?? "";
    // The clamp genuinely fired — proof this is the over-cap case, not an accidentally-under-cap one.
    expect(body.length).toBeLessThan(20_000);
    expect(body.startsWith("Understood from the original file.")).toBe(true);
  });
});

describe("runMediaPass — discovery filters threaded through", () => {
  test("passes deps.service through to discovery, excluding other services", async () => {
    const p = addMediaFile("a.mp4");
    upsertIndexedItem(db, {
      service: "onedrive",
      type: "media_av",
      externalId: "cloud-1",
      title: "cloud.mp4",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
    });
    // Only "filesystem" resolves a modality (the registry has no onedrive entry), so scoping to
    // "filesystem" should understand exactly the one filesystem candidate.
    const summary = await runMediaPass(deps({ service: "filesystem" }));
    expect(summary.understood).toBe(1);
  });

  test("passes deps.modality through to discovery", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps({ modality: "av" }));
    expect(summary.understood).toBe(1);
  });

  test("an unmatched modality filter understands nothing", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps({ modality: "image" }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  test("passes deps.sinceMs through to discovery, excluding older items", async () => {
    const p = join(root, "old.mp4");
    writeFileSync(p, "x");
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "media_av",
      externalId: p,
      title: "old.mp4",
      bodyPreview: "",
      modifiedAt: 100,
      syncedAt: 100,
      metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
    });
    const summary = await runMediaPass(deps({ sinceMs: 500 }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  test("passes deps.afterItemId through to discovery, resuming past a cursor", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    // Neither has been understood yet — find their ids and sort order WITHOUT running a pass,
    // so the isolation is on the afterItemId filter, not on idempotency (an already-understood
    // item is excluded from candidates regardless of afterItemId, which would make this test
    // pass for the wrong reason).
    const [first] = findCandidates(db, { limit: 1 });
    if (first === undefined) throw new Error("expected a candidate");

    const summary = await runMediaPass(deps({ afterItemId: first.itemId }));
    // Exactly one candidate sorts after the cursor — proof the filter reached discovery, since
    // without it both a.mp4 and b.mp4 (neither yet understood) would be eligible.
    expect(summary.understood).toBe(1);
  });
});

describe("runMediaPass — scratch sweep", () => {
  test("sweeps stale scratch WAVs at the start of the pass when scratchDir is set", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const stale = join(scratchDir, "nimbus-stt-old.wav");
    writeFileSync(stale, "x");
    // Backdate the file well past the sweep's default 1h max age.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, past, past);

    addMediaFile("a.mp4");
    await runMediaPass(deps({ scratchDir, nowMs: () => Date.now() }));

    expect(existsSync(stale)).toBe(false);
  });

  test("runs with no scratch sweep at all when scratchDir is omitted", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.understood).toBe(1);
  });
});

describe("runMediaPass — cursor resume", () => {
  test("resumes from the stored cursor when afterItemId is not explicitly supplied", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    const [first] = findCandidates(db, { limit: 1 });
    if (first === undefined) throw new Error("expected a candidate");
    // Seed the cursor exactly as an earlier, interrupted run would have left it — WITHOUT
    // running a pass first, so this isolates the READ half of resumability from the WRITE half
    // (already covered by the "advances the cursor" tests above).
    writeCursor(db, "default", { lastItemId: first.itemId, processedCount: 1, nowMs: 5000 });

    const summary = await runMediaPass(deps());

    // Two candidates sort after the seeded cursor — the first is not reprocessed.
    expect(summary.understood).toBe(2);
    const understoodFirst = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM item WHERE service='nimbus' AND external_id = ?",
      )
      .get(understandingExternalId(first.itemId));
    expect(understoodFirst?.n).toBe(0);
  });

  test("an explicit afterItemId overrides the stored cursor", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    const candidates = findCandidates(db, { limit: 3 });
    const [first, second] = candidates;
    if (first === undefined || second === undefined) throw new Error("expected two candidates");
    // Seed the cursor at the SECOND item. If the caller's explicit afterItemId did not win, this
    // run would resume from "second" and understand only the third candidate.
    writeCursor(db, "default", { lastItemId: second.itemId, processedCount: 2, nowMs: 5000 });

    const summary = await runMediaPass(deps({ afterItemId: first.itemId }));

    // afterItemId=first makes both second and third eligible — proof the caller's explicit
    // value won over the stored (further-along) cursor.
    expect(summary.understood).toBe(2);
  });

  test("a drained run clears the cursor, so a subsequent run retries a previously skipped artifact", async () => {
    addMediaFile("unreadable.mp4");
    // roots: [] means the single candidate is skipped with path_outside_roots and never
    // understood — a transient-failure stand-in.
    const first = await runMediaPass(deps({ roots: [] }));
    expect(first.understood).toBe(0);
    expect(first.skipped).toBe(1);

    // Fewer candidates than the limit (1 of 100) means the queue drained — the cursor must be
    // gone, not merely unread, or the next run would resume PAST the skipped artifact forever.
    const cursorAfterDrain = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_pass_cursor")
      .get();
    expect(cursorAfterDrain?.n).toBe(0);

    // A second run, now with a working root, retries the same artifact from the top rather than
    // resuming past it — proof the cursor was actually cleared, not merely left unread.
    const second = await runMediaPass(deps());
    expect(second.understood).toBe(1);
  });

  test("a normal run reports stopReason completed and zero cloud bytes", async () => {
    const summary = await runMediaPass(deps());
    expect(summary.stopReason).toBe("completed");
    expect(summary.cloudBytesFetched).toBe(0);
  });
});

describe("priceRun", () => {
  const base: MediaCandidate = {
    itemId: "google_drive:a",
    service: "google_drive",
    externalId: "a",
    type: "media_image",
    title: "a",
    url: null,
    modality: "image",
    sourcePath: null,
    sourceMime: "image/png",
    sourceBytes: null,
  };

  test("prices a run without inventing a number for unknown sizes", () => {
    const priced = priceRun([
      { ...base, sourceBytes: 1000 },
      { ...base, sourceBytes: 2000 },
      { ...base, sourceBytes: null },
    ]);
    expect(priced).toEqual({ knownBytes: 3000, knownCount: 2, unknownCount: 1 });
  });

  test("an all-unknown batch prices as zero known bytes across zero known candidates — never folded into a false zero total", () => {
    const priced = priceRun([
      { ...base, sourceBytes: null },
      { ...base, sourceBytes: null },
    ]);
    expect(priced).toEqual({ knownBytes: 0, knownCount: 0, unknownCount: 2 });
  });

  test("an empty candidate list prices as all-zero", () => {
    expect(priceRun([])).toEqual({ knownBytes: 0, knownCount: 0, unknownCount: 0 });
  });
});

describe("runMediaPass — cloud budget, stop reasons and rendition (PR 3)", () => {
  function cloudScratchDir(): string {
    return mkdtempSync(join(tmpdir(), "nimbus-cloud-scratch-"));
  }

  test("a pre-flight budget refusal skips the whole batch before fetching a single byte", async () => {
    addDriveItem("cpre-a", { sizeBytes: 5_000_000 });
    addDriveItem("cpre-b", { sizeBytes: 5_000_000 });
    let fetchCalls = 0;
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        fetchBudgetBytes: 1000,
        cloudBytes: cloudDeps({
          fetchFn: async () => {
            fetchCalls += 1;
            return new Response("never");
          },
        }),
      }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");
    expect(summary.understood).toBe(0);
    expect(summary.lastItemId).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("a pre-flight refusal REPORTS the numbers it priced, including the local candidates it also blocks", async () => {
    // Two cloud candidates with declared sizes, one cloud candidate with none (Photos indexes no
    // byte size), and one LOCAL file that needs no network at all. The refusal returns before the
    // loop, so all four are blocked — and until `preflightRefusal` existed every one of these
    // numbers was computed and thrown away, leaving the CLI to print generic guidance over an
    // all-zero summary on the one screen a wedged pass ever shows.
    addDriveItem("cnum-a", { sizeBytes: 5_000_000 });
    addDriveItem("cnum-b", { sizeBytes: 3_000_000 });
    addPhotosItem("cnum-c");
    addMediaFile("cnum-local.mp4");
    const summary = await runMediaPass(
      deps({ scratchDir: cloudScratchDir(), fetchBudgetBytes: 1_000 }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");
    expect(summary.preflightRefusal).toEqual({
      candidateCount: 4,
      cloudCount: 3,
      knownBytes: 8_000_000,
      knownCount: 2,
      unknownCount: 1,
      budgetBytes: 1_000,
    });
  });

  test("a MID-RUN stop reports preflightRefusal null — it is not the same outcome and must not borrow its numbers", async () => {
    // A prior candidate spends part of the budget first, so this is a genuine transient mid-run
    // stop rather than the permanent per-item refusal. The cursor moved and bytes were fetched;
    // presenting the pre-flight refusal's "nothing was fetched" wording here would be false.
    addDriveItem("cmid-0");
    addDriveItem("cmid-a");
    const chunk = new Uint8Array(1_800_000);
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        maxBytes: 5_000_000,
        fetchBudgetBytes: 1_000_000,
        cloudBytes: cloudDeps({
          fetchFn: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(chunk);
                  controller.close();
                },
              }),
            ),
        }),
      }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");
    expect(summary.preflightRefusal).toBeNull();
  });

  test("a pre-flight budget refusal does NOT clear a previously seeded cursor, even on a short page", async () => {
    // Seeded BELOW every id this test adds (ASCII '0' sorts before the lowercase item names), so
    // it is a genuine prior cursor discovery resumes past, not one that happens to already exclude
    // the new candidate.
    writeCursor(db, "default", {
      lastItemId: "google_drive:0-prior",
      processedCount: 1,
      nowMs: 5000,
    });
    addDriveItem("cguard-only", { sizeBytes: 5_000 });

    const summary = await runMediaPass(
      deps({ scratchDir: cloudScratchDir(), limit: 50, fetchBudgetBytes: 100 }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");

    // candidates.length (1) < limit (50) is a "short page" by the OLD rule's own test — proof the
    // fix is the stopReason guard, not merely "never called when there was more work left".
    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id).toBe("google_drive:0-prior");
  });

  test("a TRANSIENT mid-run budget stop retries the STOPPING artifact on resume — the cursor reflects the last COMPLETED item, not the one that stopped", async () => {
    // DIRECTED OVERRIDE (controller review): the brief's own illustrative test asserted
    // `lastItemId === c2.itemId` (the STOPPING candidate). That was wrong — c2's bytes were never
    // fetched to completion, so advancing the cursor onto it would make a resume skip an artifact
    // that was never actually understood, self-healing only when a LATER run happens to drain the
    // whole queue and clear the cursor (which, on a growing library, may be never). The cursor
    // must stay at c1 — the last artifact that genuinely completed — so a resume retries c2.
    //
    // This is the TRANSIENT case specifically: c1 completes FIRST and spends 2 bytes of the
    // budget, so c2's stop happens with `budgetBeforeThisFetch` (998) !== the full budget (1000) —
    // c2 might well fit in a FUTURE run's fresh budget, so the pass stops rather than treating it
    // as a permanent per-item refusal. See the fix-round-2 test below for the PERMANENT case,
    // where nothing was spent before the stopping candidate's own attempt.
    addDriveItem("cbud-c1");
    addDriveItem("cbud-c2");
    addDriveItem("cbud-c3");
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        fetchBudgetBytes: 1000,
        cloudBytes: cloudDeps({
          fetchFn: async (url) => {
            if (url.includes("cbud-c2")) {
              return new Response(null, { status: 200, headers: { "content-length": "5000" } });
            }
            return new Response("OK");
          },
        }),
      }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");
    expect(summary.understood).toBe(1);
    expect(summary.lastItemId).toBe("google_drive:cbud-c1");
    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("a PERMANENTLY-oversized cloud candidate — nothing spent yet this run — is a per-item over_byte_cap refusal, not a pass-level stop", async () => {
    // FIX ROUND 2 (controller review): the original version of this test asserted the opposite —
    // that a stop on the very first candidate this run left `lastItemId` null and a pre-seeded
    // cursor untouched. That was a genuine LIVELOCK: nothing ever advances past this candidate, so
    // the next run returns the identical page and stops on the identical candidate, forever —
    // starving every artifact that sorts after it in `src.id` order, local ones included.
    //
    // `budgetBeforeThisFetch === deps.fetchBudgetBytes` here (this candidate is the first cloud
    // fetch attempted this run) means the artifact was offered the ENTIRE run budget and still
    // couldn't fit — provably true of every future run using the same budget too. This is exactly
    // the shape an unknown-size Photos candidate produces in production: `priceRun`'s pre-flight
    // admits it (it contributes nothing to `knownBytes`), and only the fetch itself discovers the
    // size is too large.
    addDriveItem("cperm-solo");
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        fetchBudgetBytes: 1000,
        cloudBytes: cloudDeps({
          fetchFn: async () =>
            new Response(null, { status: 200, headers: { "content-length": "5000" } }),
        }),
      }),
    );
    expect(summary.stopReason).toBe("completed");
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason.over_byte_cap).toBe(1);
    expect(summary.lastItemId).toBe("google_drive:cperm-solo");
  });

  test("a permanently-oversized artifact does not wedge the pass — later candidates progress in the SAME run, and a LATER run keeps making progress past it", async () => {
    addDriveItem("cperm-a"); // permanently over the run budget alone
    addDriveItem("cperm-b"); // would succeed whenever actually reached
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes("cperm-a")) {
        return new Response(null, { status: 200, headers: { "content-length": "5000" } });
      }
      return new Response("OK");
    };
    const passDeps = () =>
      deps({
        scratchDir: cloudScratchDir(),
        fetchBudgetBytes: 1000,
        cloudBytes: cloudDeps({ fetchFn }),
      });

    // Same-run progress: cperm-a is refused per-item and the loop CONTINUES to cperm-b, which
    // succeeds — proof the permanently-oversized artifact does not stop the batch it is in.
    const first = await runMediaPass(passDeps());
    expect(first.stopReason).toBe("completed");
    expect(first.skippedByReason.over_byte_cap).toBe(1);
    expect(first.understood).toBe(1);

    // A second run: the property with no coverage before this fix — resume does not wedge on the
    // oversized artifact either. It is retried (a SKIP always gets "another chance", same as any
    // other skip reason — this run's short page clears the cursor at the end), refused again the
    // same honest way, and the already-understood cperm-b is correctly not re-fetched.
    const second = await runMediaPass(passDeps());
    expect(second.skippedByReason.over_byte_cap).toBe(1);
    expect(second.understood).toBe(0);
  });

  test("a rate-limit stop reports rate_limited, not budget_exhausted", async () => {
    addDriveItem("crl-a");
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
        }),
      }),
    );
    expect(summary.stopReason).toBe("rate_limited");
    expect(summary.understood).toBe(0);
  });

  test("debits bytes fetched on the OK arm too — not only a stop's", async () => {
    addDriveItem("cok-a");
    const body = "z".repeat(777);
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({ fetchFn: async () => new Response(body) }),
      }),
    );
    expect(summary.understood).toBe(1);
    expect(summary.cloudBytesFetched).toBe(777);
  });

  test("debits bytes fetched on a per-item SKIP arm too — over_byte_cap after partial streaming still counts the bytes that crossed the wire", async () => {
    addDriveItem("cskip-a");
    const chunk = new Uint8Array(2_000);
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        // Smaller than the chunk, so the PER-ARTIFACT cap fires — not the run budget, which stays
        // generous — isolating the skip arm's debit from the stop arm's (already pinned above).
        maxBytes: 1_000,
        fetchBudgetBytes: 1_000_000,
        cloudBytes: cloudDeps({
          fetchFn: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(chunk);
                  controller.close();
                },
              }),
            ),
        }),
      }),
    );
    expect(summary.stopReason).toBe("completed");
    expect(summary.skippedByReason.over_byte_cap).toBe(1);
    expect(summary.cloudBytesFetched).toBe(2_000);
  });

  test("counts partial bytes transferred before a TRANSIENT budget abort — bytes that crossed the wire are never reported as zero", async () => {
    // A prior candidate completes FIRST and spends a little budget, so the streaming candidate's
    // own stop is TRANSIENT (`budgetBeforeThisFetch` !== the full budget) rather than the
    // PERMANENT per-item-refusal case (fix round 2) — this test is specifically about the byte
    // COUNT on a genuine pass-level stop, which the permanent case no longer produces.
    addDriveItem("cpartial-0");
    addDriveItem("cpartial-a");
    const chunk = new Uint8Array(1_800_000);
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        // Larger than the chunk, so the PER-ARTIFACT cap never fires first — this test isolates
        // the RUN budget specifically.
        maxBytes: 5_000_000,
        fetchBudgetBytes: 1_000_000,
        cloudBytes: cloudDeps({
          fetchFn: async (url) => {
            if (url.includes("cpartial-a")) {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(chunk);
                    controller.close();
                  },
                }),
              );
            }
            return new Response("OK");
          },
        }),
      }),
    );
    expect(summary.stopReason).toBe("budget_exhausted");
    expect(summary.understood).toBe(1);
    // 2 bytes from "OK" (cpartial-0) + the full 1.8 MB chunk that crossed the wire before the
    // abort (cpartial-a) — both arms debited, matching the "debits EVERY arm" property above.
    expect(summary.cloudBytesFetched).toBe(2 + 1_800_000);
  });

  test("deletes a cloud AV scratch file after a SUCCESSFUL understanding", async () => {
    addDriveItem("cav-ok", { modality: "av" });
    const scratchDir = cloudScratchDir();
    const summary = await runMediaPass(
      deps({
        scratchDir,
        cloudBytes: cloudDeps({ fetchFn: async () => new Response("video-bytes") }),
      }),
    );
    expect(summary.understood).toBe(1);
    expect(readdirSync(scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });

  test("deletes the scratch file even when understanding THROWS", async () => {
    addDriveItem("cav-throw", { modality: "av" });
    const scratchDir = cloudScratchDir();
    await runMediaPass(
      deps({
        scratchDir,
        cloudBytes: cloudDeps({ fetchFn: async () => new Response("video-bytes") }),
        gate: {
          enabled: true,
          capabilityDisabled: false,
          // Throws SYNCHRONOUSLY, unlike a throw from `understand()` — which `understandArtifact`
          // already catches internally and turns into `transcribe_failed`. This is the one call in
          // the gate NOT wrapped in a try/catch, so it is what actually exercises the throwing path
          // through this loop's own `finally`, rather than the ordinary skip branch.
          understanderFor: () => {
            throw new Error("model died");
          },
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    ).catch(() => undefined);
    expect(readdirSync(scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });

  test("a google_photos candidate resolves its byte URL before fetching bytes — an indexed baseUrl would be expired", async () => {
    addPhotosItem("cphoto-a");
    const calls: string[] = [];
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          fetchFn: async (url) => {
            calls.push(url);
            if (isHost(url, "photoslibrary.googleapis.com")) {
              return new Response(JSON.stringify({ baseUrl: "https://photos.example.test/real" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("photo-bytes");
          },
        }),
      }),
    );
    expect(summary.understood).toBe(1);
    expect(calls.some((u) => isHost(u, "photoslibrary.googleapis.com"))).toBe(true);
    expect(calls.some((u) => u.startsWith("https://photos.example.test/real"))).toBe(true);
  });

  test("a google_photos fetch with preferRenditions records the downsized rendition; Drive never varies", async () => {
    addPhotosItem("crend-photo");
    addDriveItem("crend-drive");
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        preferRenditions: true,
        cloudBytes: cloudDeps({
          fetchFn: async (url) => {
            if (isHost(url, "photoslibrary.googleapis.com")) {
              return new Response(JSON.stringify({ baseUrl: "https://photos.example.test/real" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("bytes");
          },
        }),
      }),
    );
    expect(summary.understood).toBe(2);

    const rows = db
      .query<{ external_id: string; metadata: string | null; body: string }, []>(
        "SELECT external_id, metadata, body FROM item WHERE service='nimbus' AND type='image_understanding' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    const drive = rows.find((r) => r.external_id.startsWith("google_drive:"));
    const photo = rows.find((r) => r.external_id.startsWith("google_photos:"));
    if (drive === undefined || photo === undefined) throw new Error("expected both rows");

    // Drive has no rendition to offer, so it stays "original" regardless of preferRenditions.
    expect(JSON.parse(drive.metadata ?? "{}")["rendition"]).toBe("original");
    expect(drive.body).toContain("Understood from the original file.");

    // Photos DOES vary, and the fetch requested the downsized suffix on the re-resolved baseUrl.
    expect(JSON.parse(photo.metadata ?? "{}")["rendition"]).toBe("w2048-h2048");
    expect(photo.body).toContain("downsized rendition");
  });

  test("BOTH outbound requests of a Photos candidate are ledgered — the resolve round-trip and the byte fetch", async () => {
    addPhotosItem("cledger-a");
    const rows: Array<{ destination: string; method: string }> = [];
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          appendEgress: (row) => {
            rows.push(row);
            return { rowHash: "h" };
          },
          fetchFn: async (url) => {
            if (isHost(url, "photoslibrary.googleapis.com")) {
              return new Response(JSON.stringify({ baseUrl: "https://photos.example.test/real" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("photo-bytes");
          },
        }),
      }),
    );
    expect(summary.understood).toBe(1);
    // Two real credentialed/pre-signed requests leave the machine per Photos candidate, so two
    // rows must exist and they must be distinguishable. One row for two requests was the gap.
    expect(rows).toEqual([
      { destination: "google_photos", method: "media.resolveByteUrl" },
      { destination: "google_photos", method: "media.fetchBytes" },
    ]);
  });

  test("a Drive candidate ledgers only its byte fetch — the resolver makes no round-trip to record", async () => {
    addDriveItem("cledger-drive");
    const rows: Array<{ destination: string; method: string }> = [];
    await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          appendEgress: (row) => {
            rows.push(row);
            return { rowHash: "h" };
          },
          fetchFn: async () => new Response("drive-bytes"),
        }),
      }),
    );
    expect(rows).toEqual([{ destination: "google_drive", method: "media.fetchBytes" }]);
  });

  test("a 429 AT RESOLVE stops the run like a 429 at fetch — it does not burn the page as per-item skips", async () => {
    // Three candidates, all resolving to the same provider-wide 429. The pre-fix behaviour treated
    // a resolver error as a per-item skip that ADVANCES: all three would be skipped, the cursor
    // would move past every one of them, and the run would report `completed` — so the CLI would
    // print no resume guidance for a page nothing was attempted on.
    addPhotosItem("crlr-a");
    addPhotosItem("crlr-b");
    addPhotosItem("crlr-c");
    let resolveCalls = 0;
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          fetchFn: async () => {
            resolveCalls += 1;
            return new Response("rate limited", { status: 429 });
          },
        }),
      }),
    );
    expect(summary.stopReason).toBe("rate_limited");
    expect(summary.skipped).toBe(0);
    expect(summary.skippedByReason.rate_limited).toBe(0);
    // Stopped on the FIRST one, not after walking the whole page.
    expect(resolveCalls).toBe(1);
    // The cursor is left where it was — untouched, so the very first candidate is RETRIED next
    // run rather than skipped past.
    expect(readCursor(db, "default")).toBe(null);
  });

  test("a NON-429 resolver error stays a per-item skip that advances", async () => {
    // The distinction I1 turns on: only `rate_limited` is provider-wide. A 500 on one artifact
    // says nothing about the next one, so the pass must keep going and record the skip.
    addPhotosItem("crls-a");
    addPhotosItem("crls-b");
    let resolveCalls = 0;
    const summary = await runMediaPass(
      deps({
        scratchDir: cloudScratchDir(),
        cloudBytes: cloudDeps({
          fetchFn: async () => {
            resolveCalls += 1;
            return new Response("server error", { status: 500 });
          },
        }),
      }),
    );
    expect(summary.stopReason).toBe("completed");
    expect(summary.skipped).toBe(2);
    expect(summary.skippedByReason.fetch_miss).toBe(2);
    expect(resolveCalls).toBe(2);
  });
});

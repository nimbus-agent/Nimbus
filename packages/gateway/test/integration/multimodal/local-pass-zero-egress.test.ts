// packages/gateway/test/integration/multimodal/local-pass-zero-egress.test.ts
/**
 * "A fully local understanding pass appends zero rows to `egress_ledger`" is a claim that passes
 * for ANY reason if asserted alone — including the pass never running, finding no candidates,
 * failing silently, or never reaching a model at all. This file is written control-first so the
 * zero-row assertion means something:
 *
 *  1. The POSITIVE CONTROL proves the pass genuinely does work — the understander is reached
 *     (call count exactly 1) and a derived `video_understanding` row is produced.
 *  2. THE CLAIM — given the control holds, a local pass leaves the ledger at zero.
 *  3. THE REFUSAL CASE — a non-local understander is refused BEFORE contact (call count 0), and
 *     still appends nothing, pinning that the refusal happens before the model call rather than
 *     after it.
 *
 * Mirrors `packages/gateway/test/integration/computer-use/terminal-loopback.test.ts`, which ran
 * the same command through an unconfined shell first as a positive control, for the same reason:
 * "zero server hits" cannot mean anything without proof that a hit was possible in the first place.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import type { MediaGateDeps } from "../../../src/multimodal/media-gate.ts";
import type { MediaCloudDeps } from "../../../src/multimodal/media-pass.ts";
import { runMediaPass } from "../../../src/multimodal/media-pass.ts";
import {
  DEFAULT_FETCH_BUDGET_BYTES,
  DEFAULT_PREFER_RENDITIONS,
} from "../../../src/multimodal/multimodal-config.ts";

let db: Database;
let root: string;

/**
 * `MediaPassDeps.cloudBytes` is REQUIRED (PR 3), but every candidate `addMedia` seeds is
 * `filesystem`-backed (a real `sourcePath`), so `runMediaPass` never reaches the cloud arm at all
 * in this file — its whole point is the LOCAL arm's egress claim. Every collaborator here THROWS
 * if actually invoked, so a future change that accidentally makes one of this file's candidates
 * cloud-backed (or otherwise routes through `resolveCloudByteUrl`/`fetchCloudBytes`) fails LOUDLY
 * here, rather than silently turning this into a cloud-path test under a name and a doc comment
 * that both say it is not one.
 */
function unreachableCloudBytes(): MediaCloudDeps {
  const unreachable = (): never => {
    throw new Error(
      "local-pass-zero-egress.test.ts: the cloud arm must not be reached — every candidate here is local",
    );
  };
  return {
    bearerFor: () => unreachable(),
    fetchFn: () => unreachable(),
    appendEgress: () => unreachable(),
    sleep: () => unreachable(),
  };
}

function addMedia(name: string): void {
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
}

function countEgress(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n ?? 0;
}

function gate(isLocal: boolean, onCall: () => void): MediaGateDeps {
  return {
    enabled: true,
    capabilityDisabled: false,
    understanderFor: () => ({
      isLocal,
      model: isLocal ? "whisper-base" : "remote-stt",
      isAvailable: async () => true,
      understand: async () => {
        onCall();
        return { text: "transcript" };
      },
    }),
    gpu: { acquire: async () => () => undefined, touch: () => undefined },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  root = mkdtempSync(join(tmpdir(), "nimbus-egress-"));
});

describe("local understanding pass — egress", () => {
  /**
   * POSITIVE CONTROL. Without this, "zero rows" below would pass even if the pass never reached a
   * model, never read a file, or silently found no candidates. This asserts the pass DOES do work
   * and DOES reach the understander — so the zero-row assertion afterwards means something.
   */
  test("control: the pass genuinely reaches the understander and produces a derived item", async () => {
    addMedia("a.mp4");
    let called = 0;
    const summary = await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "control",
      gate: gate(true, () => {
        called += 1;
      }),
      fetchBudgetBytes: DEFAULT_FETCH_BUDGET_BYTES,
      preferRenditions: DEFAULT_PREFER_RENDITIONS,
      cloudBytes: unreachableCloudBytes(),
    });

    expect(called).toBe(1);
    expect(summary.understood).toBe(1);
    const derived = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .get()?.n;
    expect(derived).toBe(1);
  });

  /**
   * The claim. Given the control above proves the pass did real work, a zero count here means no
   * outbound request was made — not that nothing happened.
   */
  test("a fully local pass appends ZERO egress rows", async () => {
    addMedia("a.mp4");
    addMedia("b.mp4");
    expect(countEgress()).toBe(0);

    await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "claim",
      gate: gate(true, () => undefined),
      fetchBudgetBytes: DEFAULT_FETCH_BUDGET_BYTES,
      preferRenditions: DEFAULT_PREFER_RENDITIONS,
      cloudBytes: unreachableCloudBytes(),
    });

    expect(countEgress()).toBe(0);
  });

  /**
   * The gate refuses a non-local understander outright in PR 1 (no grant store exists yet), so it
   * must never reach the model AND must never ledger. This pins that the refusal happens BEFORE
   * the model call rather than after it.
   */
  test("a non-local understander is refused before contact, and still appends nothing", async () => {
    addMedia("a.mp4");
    let called = 0;
    const summary = await runMediaPass({
      db,
      roots: [root],
      limit: 10,
      maxBytes: 1_000_000,
      nowMs: () => 5000,
      passId: "remote",
      gate: gate(false, () => {
        called += 1;
      }),
      fetchBudgetBytes: DEFAULT_FETCH_BUDGET_BYTES,
      preferRenditions: DEFAULT_PREFER_RENDITIONS,
      cloudBytes: unreachableCloudBytes(),
    });

    expect(called).toBe(0);
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_remote_grant"]).toBe(1);
    expect(countEgress()).toBe(0);
  });
});

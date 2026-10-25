/**
 * Role packs P2 done-when (spec § 9): "A Google Doc's text is in the index and a decision written in
 * it is mined after installing PM 1.1.0."
 *
 * The Doc reaches the index through the REAL Drive sync (its export, the depth chokepoint), not a
 * hand-written row, and the mapping is resolved from the bundled PM pack's own defaults text — so a
 * writer that stopped emitting `google_drive:doc`, or a PM pack that stopped mapping it, fails here.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import {
  createGoogleDriveSyncable,
  encodeDriveSyncCursor,
} from "../connectors/google-drive-sync.ts";
import { BUNDLED_PACKS } from "../packs/bundled-packs.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  resolveSourceMapping,
  type SourceMapping,
} from "../sources/source-mapping.ts";
import { runDecisionPass } from "./decision-extract.ts";
import { listDecisions } from "./decision-store.ts";

const CHANGES_LIST_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/changes\?/;
const EXPORT_RE = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^/?]+\/export\?/;

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function pmPackMapping(): SourceMapping {
  const pm = BUNDLED_PACKS.get("pm");
  if (pm === undefined) throw new Error("pm pack missing");
  const doc = parseLayerDoc({ kind: "pack", id: "pm", path: "/virtual/pm.toml" }, pm.defaults);
  return resolveSourceMapping({ doc: mergeLayerDocs([doc]) });
}

async function syncOneDoc(text: string): Promise<void> {
  const modifiedTime = new Date(Date.now() - 86_400_000).toISOString();
  fetchStub.respond("GET", CHANGES_LIST_RE, {
    newStartPageToken: "next",
    changes: [
      {
        fileId: "doc-1",
        file: {
          id: "doc-1",
          name: "Billing storage — decision log",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime,
        },
      },
    ],
  });
  fetchStub.respondWithText("GET", EXPORT_RE, text);
  await createGoogleDriveSyncable({ ensureGoogleDriveRunning: async () => {} }).sync(
    {
      ...syncTestContext(db, EMPTY_NIMBUS_VAULT, "google_drive"),
      accessToken: () => Promise.resolve("t"),
    },
    encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: "p", docs: { doneAt: "full" } }),
  );
}

const PASS = {
  nowMs: Date.now(),
  useLlm: false,
  maxLlmCalls: 25,
  retryCooldownMs: 1_000,
};

test("a decision written in a Google Doc is mined under the PM pack's mapping", async () => {
  await syncOneDoc("Notes from Tuesday.\n\nWe decided to move billing to Postgres.\n");
  const mapping = pmPackMapping();
  expect(mapping.kindOf("google_drive:doc")).toBe("doc");

  await runDecisionPass(db, { ...PASS, mapping });

  const rows = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10, mapping });
  expect(rows.map((r) => r.sourceItemId)).toEqual(["google_drive:doc-1"]);
});

test("without the pack the same Doc is not a decision source", async () => {
  await syncOneDoc("We decided to move billing to Postgres.\n");
  expect(BUILTIN_SOURCE_MAPPING.kindOf("google_drive:doc")).toBeUndefined();

  await runDecisionPass(db, { ...PASS, mapping: BUILTIN_SOURCE_MAPPING });

  expect(
    listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10, mapping: BUILTIN_SOURCE_MAPPING }),
  ).toEqual([]);
});

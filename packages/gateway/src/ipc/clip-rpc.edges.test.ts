import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { API_SCOPES, LEGACY_SCOPES } from "../clips/api-scopes.ts";
import { ingestClip } from "../clips/clip-ingest.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { dispatchClipRpc } from "./clip-rpc.ts";

/**
 * `clip-rpc.ts` paths `clip-rpc.test.ts` does not reach: a non-object `clip.pair` payload, a
 * `scopes` value that is not an array (refused before any pairing window opens), `clip.scopes`
 * with no usable label, legacy rows whose nullable `metadata`/`url` columns are NULL or hold a
 * JSON scalar, rows whose `title`/`modified_at` hold a value their column affinity could not
 * coerce, and `clip.delete` with a non-string target.
 */

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

/** Records every key read (`reads`) and every set/delete (`writes`). */
function recordingVault(): { vault: NimbusVault; reads: string[]; writes: string[] } {
  const store = new Map<string, string>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    reads,
    writes,
    vault: {
      get: async (k) => {
        reads.push(k);
        return store.get(k) ?? null;
      },
      set: async (k, v) => {
        writes.push(k);
        store.set(k, v);
      },
      delete: async (k) => {
        writes.push(`delete:${k}`);
        store.delete(k);
      },
      listKeys: async () => [...store.keys()],
    },
  };
}

function deps(over: { db?: Database } = {}) {
  const { vault, reads, writes } = recordingVault();
  return {
    reads,
    writes,
    deps: {
      pairing: new PairingWindowController({ nowMs: () => 1000, genCode: () => "654321" }),
      vault,
      briefsEnabled: false,
      ...over,
    },
  };
}

function indexDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

describe("clip.pair", () => {
  test("a non-object payload pairs a generated device label with the legacy scopes", async () => {
    for (const params of [null, "chrome", 7]) {
      const { deps: d } = deps();
      const out = await dispatchClipRpc("clip.pair", params, d);
      const value = (out as { value: { label: string; scopes: string[]; code: string } }).value;
      expect(value.label).toMatch(/^device-[0-9a-f]{6}$/);
      expect(value.scopes).toEqual([...LEGACY_SCOPES]);
      expect(d.pairing.isOpen()).toBe(true);
    }
  });

  test("scopes that are not an array are refused — and no pairing window opens", async () => {
    for (const scopes of ["clip", { clip: true }, 1]) {
      const { deps: d } = deps();
      const err: unknown = await dispatchClipRpc("clip.pair", { label: "chrome", scopes }, d).then(
        (v) => new Error(`resolved: ${JSON.stringify(v)}`),
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toBe(`scopes must be an array of: ${API_SCOPES.join(", ")}`);
      expect(d.pairing.isOpen()).toBe(false);
    }
  });
});

describe("clip.scopes", () => {
  test("with no usable label it updates nothing and touches no Vault key", async () => {
    for (const params of [{ scopes: ["clip"] }, { label: 7, scopes: ["clip"] }, { label: "" }]) {
      const { deps: d, reads, writes } = deps();
      const out = await dispatchClipRpc("clip.scopes", params, d);
      expect(out).toEqual({ kind: "hit", value: { updated: false, scopes: [] } });
      // Not even read: an empty label short-circuits before the token map is loaded. Without the
      // short-circuit the same `{updated:false}` comes back — the read is what tells them apart.
      expect(reads).toEqual([]);
      expect(writes).toEqual([]);
    }
  });
});

describe("clip.list — legacy rows whose nullable columns are empty", () => {
  test("NULL or scalar metadata and a NULL url read as empty fields, never throw", async () => {
    const db = indexDb();
    const ids: string[] = [];
    const urls = ["https://a.com/1", "https://a.com/2", "https://a.com/3", "https://a.com/4"];
    for (const [i, url] of urls.entries()) {
      ids.push(
        ingestClip(db, {
          url,
          title: `T${i}`,
          body: "two words",
          mode: "article",
          tags: ["kept"],
          capturedAt: 1000 + i,
        }).id,
      );
    }
    // A clip from before metadata was written, one whose metadata is a JSON number, one whose
    // metadata is JSON `null` (parses fine, yet is not an object to read fields off), and one that
    // lost its URL — every one a value the column allows.
    db.run("UPDATE item SET metadata = NULL WHERE id = ?", [ids[0] ?? ""]);
    db.run("UPDATE item SET metadata = '42' WHERE id = ?", [ids[1] ?? ""]);
    db.run("UPDATE item SET url = NULL WHERE id = ?", [ids[2] ?? ""]);
    db.run("UPDATE item SET metadata = 'null' WHERE id = ?", [ids[3] ?? ""]);

    const out = await dispatchClipRpc("clip.list", {}, deps({ db }).deps);
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    const byId = new Map(clips.map((c) => [c["id"], c]));
    const EMPTY_META = { tags: [], mode: "", wordCount: 0, truncated: false };
    expect(byId.get(ids[0])).toMatchObject({ ...EMPTY_META, url: "https://a.com/1" });
    expect(byId.get(ids[1])).toMatchObject({ ...EMPTY_META, url: "https://a.com/2" });
    expect(byId.get(ids[2])).toMatchObject({ url: null, tags: ["kept"], mode: "article" });
    expect(byId.get(ids[3])).toMatchObject({ ...EMPTY_META, url: "https://a.com/4" });
  });

  test("a BLOB title and a non-numeric modified_at read as '' and 0, never as bytes or text", async () => {
    const db = indexDb();
    const ids = ["https://b.com/1", "https://b.com/2"].map(
      (url, i) =>
        ingestClip(db, {
          url,
          title: `T${i}`,
          body: "two words",
          mode: "article",
          tags: [],
          capturedAt: 2000 + i,
        }).id,
    );
    // `title` is TEXT NOT NULL and `modified_at` INTEGER NOT NULL, but column affinity only
    // converts what it can: a BLOB stays a BLOB in a TEXT column, and text that is not a number
    // stays text in an INTEGER one. Neither may reach the IPC payload as-is — a byte array would
    // serialise as an index-keyed object, and a string would break every numeric sort a client does.
    db.run("UPDATE item SET title = ? WHERE id = ?", [new Uint8Array([0x41, 0x42]), ids[0] ?? ""]);
    db.run("UPDATE item SET modified_at = 'yesterday' WHERE id = ?", [ids[1] ?? ""]);

    const out = await dispatchClipRpc("clip.list", {}, deps({ db }).deps);
    const clips = (out as { value: { clips: Array<Record<string, unknown>> } }).value.clips;
    const byId = new Map(clips.map((c) => [c["id"], c]));
    // Each fallback is confined to its own field: the sibling read off the same row is untouched.
    expect(byId.get(ids[0])).toMatchObject({ title: "", clippedAt: 2000, url: "https://b.com/1" });
    expect(byId.get(ids[1])).toMatchObject({ title: "T1", clippedAt: 0, url: "https://b.com/2" });
  });
});

describe("clip.delete", () => {
  test("a non-string target matches nothing and deletes nothing", async () => {
    const db = indexDb();
    const { id } = ingestClip(db, {
      url: "https://a.com/keep",
      title: "Keep",
      body: "b",
      mode: "article",
      tags: [],
      capturedAt: 1000,
    });
    for (const target of [7, { id }, [id]]) {
      const out = await dispatchClipRpc("clip.delete", { target }, deps({ db }).deps);
      expect(out).toEqual({ kind: "hit", value: { deleted: 0, matched: 0 } });
    }
    expect(db.query("SELECT COUNT(*) AS n FROM item WHERE id = ?").get(id)).toEqual({ n: 1 });
  });
});

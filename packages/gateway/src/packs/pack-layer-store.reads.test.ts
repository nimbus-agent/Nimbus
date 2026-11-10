/** Read-side gaps of `pack-layer-store.ts`: the raw readers, and the reason a listed pack is skipped. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACK_FRAGMENT_MAX_BYTES } from "../config/pack-settable.ts";
import { createPackLayerStore } from "./pack-layer-store.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-reads-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const base = () => join(dir, "packs", "default");
const CONF = "[decisions]\nmin_confidence = 0.5\n";

describe("readPackRecord and readPackLayerText", () => {
  test("read what a set wrote, and return undefined for an invalid name or a missing file", () => {
    const store = createPackLayerStore({ configDir: dir, onChange: () => null });
    store.setPackLayer("default", "pm", CONF, { record: '{"id":"pm"}' });
    expect(store.readPackLayerText("default", "pm")).toBe(CONF);
    expect(store.readPackRecord("default", "pm")).toBe('{"id":"pm"}');
    expect(store.readPackLayerText("default", "../evil")).toBeUndefined();
    expect(store.readPackRecord("default", "../evil")).toBeUndefined();
    expect(store.readPackRecord("default", "other")).toBeUndefined();
    expect(store.readPackLayerText("default", "other")).toBeUndefined();
  });

  test("a directory or an oversized file where the layer should be reads as undefined", () => {
    const store = createPackLayerStore({ configDir: dir, onChange: () => null });
    mkdirSync(join(base(), "dirpack.toml"), { recursive: true });
    expect(store.readPackLayerText("default", "dirpack")).toBeUndefined();
    writeFileSync(join(base(), "big.toml"), "x".repeat(PACK_FRAGMENT_MAX_BYTES + 1));
    expect(store.readPackLayerText("default", "big")).toBeUndefined();
  });
});

describe("read: why a listed pack is skipped", () => {
  test("missing, oversized, not a regular file and an unparsable layer each name their reason", () => {
    mkdirSync(base(), { recursive: true });
    writeFileSync(join(base(), "big.toml"), "x".repeat(PACK_FRAGMENT_MAX_BYTES + 1));
    mkdirSync(join(base(), "dir.toml"));
    writeFileSync(join(base(), "bad.toml"), "this is = = not toml");
    writeFileSync(
      join(base(), "active.json"),
      JSON.stringify({ version: 1, packs: ["gone", "big", "dir", "bad"] }),
    );
    const store = createPackLayerStore({ configDir: dir, onChange: () => null });
    const r = store.read("default");
    expect(r.layers).toEqual([]);
    const reasons = new Map(r.skipped.map((s) => [s.packId, s.reason]));
    expect(reasons.get("gone")).toBe("missing");
    expect(reasons.get("big")).toBe(`larger than ${PACK_FRAGMENT_MAX_BYTES} bytes`);
    expect(reasons.get("dir")).toBe("not a regular file");
    expect(typeof reasons.get("bad")).toBe("string");
  });

  test("an unreadable profile name is a listError, not a throw", () => {
    const store = createPackLayerStore({ configDir: dir, onChange: () => null });
    const r = store.read("../x");
    expect(r.layers).toEqual([]);
    expect(r.listError).toBeDefined();
  });

  test("an active.json that is a directory is a listError naming the file", () => {
    mkdirSync(join(base(), "active.json"), { recursive: true });
    const store = createPackLayerStore({ configDir: dir, onChange: () => null });
    expect(store.read("default").listError).toContain("could not read active.json");
  });
});

describe("removePackLayer", () => {
  test("a pack that was never installed removes nothing and reports no snapshot", () => {
    const store = createPackLayerStore({ configDir: dir, onChange: () => 9 });
    expect(store.removePackLayer("default", "ghost")).toMatchObject({
      removed: false,
      snapshotVersion: null,
    });
  });
});

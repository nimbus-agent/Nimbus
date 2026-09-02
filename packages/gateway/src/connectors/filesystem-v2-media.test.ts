import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectMediaFiles, mimeTypeForMediaExtension } from "./filesystem-v2-sync.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nimbus-media-"));
  mkdirSync(join(root, "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "demo.mp4"), "x");
  writeFileSync(join(root, "shot.PNG"), "x");
  writeFileSync(join(root, "notes.ts"), "x");
  writeFileSync(join(root, "nested", "call.m4a"), "x");
  writeFileSync(join(root, "node_modules", "vendored.mp4"), "x");
  return root;
}

function names(files: readonly { path: string }[]): string[] {
  return files.map((f) => f.path.split(/[\\/]/).pop() ?? "").sort();
}

describe("collectMediaFiles", () => {
  test("finds media recursively and ignores non-media", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    expect(names(found)).toEqual(["call.m4a", "demo.mp4", "shot.PNG"]);
  });

  test("classifies modality, case-insensitively", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    const byName = new Map(found.map((f) => [f.path.split(/[\\/]/).pop(), f.modality]));
    expect(byName.get("demo.mp4")).toBe("av");
    expect(byName.get("shot.PNG")).toBe("image");
  });

  test("honours the file cap — a photo library must not be unbounded", () => {
    expect(collectMediaFiles(fixtureRoot(), [], 2)).toHaveLength(2);
  });

  test("excludes a directory at any depth, matching the code walk", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules"], 100);
    expect(names(found)).not.toContain("vendored.mp4");
  });

  test("excludes a nested directory by name", () => {
    const found = collectMediaFiles(fixtureRoot(), ["node_modules", "nested"], 100);
    expect(names(found)).toEqual(["demo.mp4", "shot.PNG"]);
  });
});

describe("mimeTypeForMediaExtension", () => {
  test("maps known media extensions", () => {
    expect(mimeTypeForMediaExtension(".mp4")).toBe("video/mp4");
    expect(mimeTypeForMediaExtension(".mp3")).toBe("audio/mpeg");
    expect(mimeTypeForMediaExtension(".png")).toBe("image/png");
  });

  test("is case-insensitive", () => {
    expect(mimeTypeForMediaExtension(".MP4")).toBe("video/mp4");
  });

  test("returns null rather than a guess for an unknown extension", () => {
    expect(mimeTypeForMediaExtension(".xyz")).toBeNull();
  });
});

import type { SyncContext } from "../sync/types.ts";
import { syncFilesystemMediaForRoot } from "./filesystem-v2-sync.ts";

interface UpsertCall {
  service: string;
  type: string;
  externalId: string;
  title: string;
  metadata?: Record<string, unknown>;
}

function fakeCtx(calls: UpsertCall[]): SyncContext {
  // Only `upsertItem` is exercised here. The cast is confined to this test helper so it need not
  // construct ~15 unrelated capabilities; PRODUCTION code must never cast into SyncContext — that
  // cast is the one thing D24's type narrowing cannot catch.
  return {
    upsertItem: (row: UpsertCall) => {
      calls.push(row);
    },
  } as unknown as SyncContext;
}

describe("syncFilesystemMediaForRoot", () => {
  test("upserts one bodyless item per media file", () => {
    const calls: UpsertCall[] = [];
    const res = syncFilesystemMediaForRoot(
      fakeCtx(calls),
      fixtureRoot(),
      ["node_modules"],
      100,
      1000,
    );
    expect(res.upserted).toBe(3);
    expect(calls).toHaveLength(3);
  });

  test("types each item by modality and keys it on the absolute path", () => {
    const calls: UpsertCall[] = [];
    const root = fixtureRoot();
    syncFilesystemMediaForRoot(fakeCtx(calls), root, ["node_modules"], 100, 1000);
    const mp4 = calls.find((c) => c.externalId.endsWith("demo.mp4"));
    expect(mp4?.service).toBe("filesystem");
    expect(mp4?.type).toBe("media_av");
    expect(mp4?.externalId.startsWith(root)).toBe(true);
  });

  test("records path, sizeBytes and mimeType in metadata", () => {
    const calls: UpsertCall[] = [];
    syncFilesystemMediaForRoot(fakeCtx(calls), fixtureRoot(), ["node_modules"], 100, 1000);
    const mp4 = calls.find((c) => c.externalId.endsWith("demo.mp4"));
    expect(mp4?.metadata?.["mimeType"]).toBe("video/mp4");
    expect(mp4?.metadata?.["mediaKind"]).toBe("av");
    expect(typeof mp4?.metadata?.["path"]).toBe("string");
    expect(typeof mp4?.metadata?.["sizeBytes"]).toBe("number");
  });

  test("reports zero for a root with no media", () => {
    const empty = mkdtempSync(join(tmpdir(), "nimbus-empty-"));
    const calls: UpsertCall[] = [];
    expect(syncFilesystemMediaForRoot(fakeCtx(calls), empty, [], 100, 1000).upserted).toBe(0);
  });
});

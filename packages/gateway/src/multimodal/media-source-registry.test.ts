import { describe, expect, test } from "bun:test";
import {
  ITEM_TYPE_MODALITY,
  MEDIA_EXTENSIONS,
  MIME_KEYED_SERVICES,
  mediaExtensionModality,
  mediaItemTypePairsForModality,
  mediaSourceBytes,
  modalityForItem,
} from "./media-source-registry.ts";

describe("mediaExtensionModality", () => {
  test("classifies audio and video as av", () => {
    expect(mediaExtensionModality(".mp4")).toBe("av");
    expect(mediaExtensionModality(".mp3")).toBe("av");
    expect(mediaExtensionModality(".m4a")).toBe("av");
  });

  test("classifies images", () => {
    expect(mediaExtensionModality(".png")).toBe("image");
    expect(mediaExtensionModality(".jpg")).toBe("image");
  });

  test("is case-insensitive — Windows and macOS produce upper-case extensions", () => {
    expect(mediaExtensionModality(".MP4")).toBe("av");
    expect(mediaExtensionModality(".PNG")).toBe("image");
  });

  test("returns undefined for a non-media extension rather than guessing", () => {
    expect(mediaExtensionModality(".ts")).toBeUndefined();
    expect(mediaExtensionModality("")).toBeUndefined();
  });

  test("MEDIA_EXTENSIONS covers exactly the classifiable extensions", () => {
    for (const ext of MEDIA_EXTENSIONS) {
      expect(mediaExtensionModality(ext)).toBeDefined();
    }
  });
});

describe("modalityForItem", () => {
  test("filesystem media items resolve by their recorded modality type", () => {
    expect(modalityForItem("filesystem", "media_av")).toBe("av");
    expect(modalityForItem("filesystem", "media_image")).toBe("image");
  });

  test("an unregistered pair returns undefined, never a default", () => {
    expect(modalityForItem("filesystem", "symbol")).toBeUndefined();
    expect(modalityForItem("slack", "message")).toBeUndefined();
  });
});

// Important B (fix round 3): nothing previously pinned the disjointness of ITEM_TYPE_MODALITY and
// MIME_KEYED_SERVICES. The old arm-1 SQL carried a `NOT IN (mimeServices)` clause that made this
// true structurally regardless of table contents; the pair-keyed rewrite dropped it, so this test
// (plus mediaItemTypePairsForModality's own defensive filter) is what restores the guarantee.
describe("ITEM_TYPE_MODALITY / MIME_KEYED_SERVICES disjointness (Important B)", () => {
  test("no key in ITEM_TYPE_MODALITY names a service in MIME_KEYED_SERVICES", () => {
    for (const key of ITEM_TYPE_MODALITY.keys()) {
      const service = key.slice(0, key.indexOf(":"));
      expect(MIME_KEYED_SERVICES.has(service)).toBe(false);
    }
  });

  test("mediaItemTypePairsForModality never returns a pair for a mime-keyed service", () => {
    for (const pair of mediaItemTypePairsForModality()) {
      expect(MIME_KEYED_SERVICES.has(pair.service)).toBe(false);
    }
  });
});

describe("mediaSourceBytes", () => {
  test("filesystem reads sizeBytes as a number", () => {
    expect(mediaSourceBytes("filesystem", { sizeBytes: 1234 })).toBe(1234);
  });

  test("google_drive coerces its STRING size — the Drive API returns int64 as a string", () => {
    expect(mediaSourceBytes("google_drive", { size: "8388608" })).toBe(8388608);
  });

  test("onedrive reads its numeric size", () => {
    expect(mediaSourceBytes("onedrive", { size: 4096 })).toBe(4096);
  });

  test("google_photos has no size at all — null, not zero", () => {
    expect(mediaSourceBytes("google_photos", { width: "4032", height: "3024" })).toBeNull();
  });

  test("a non-numeric string is null, not NaN", () => {
    expect(mediaSourceBytes("google_drive", { size: "not-a-number" })).toBeNull();
  });

  test("an unknown service is null rather than guessing a key", () => {
    expect(mediaSourceBytes("slack", { size: 99 })).toBeNull();
  });
});

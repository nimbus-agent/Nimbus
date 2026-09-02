import { describe, expect, test } from "bun:test";
import {
  MEDIA_EXTENSIONS,
  mediaExtensionModality,
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

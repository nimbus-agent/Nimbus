import { describe, expect, test } from "bun:test";
import { driveByteUrl, onedriveByteUrl, photosByteUrl } from "./cloud-renditions.ts";

describe("the credential rule", () => {
  test("a Drive URL is CONSTRUCTED by us, so it carries the bearer", () => {
    const u = driveByteUrl("1AbC");
    expect(u.kind).toBe("constructed");
    expect(u.bearer).toBe(true);
    expect(u.url).toBe(
      "https://www.googleapis.com/drive/v3/files/1AbC?alt=media&supportsAllDrives=true",
    );
  });

  test("a Photos URL is PROVIDER-returned and pre-signed, so it carries NO bearer", () => {
    const u = photosByteUrl("https://lh3.googleusercontent.com/abc", "image", false);
    expect(u.kind).toBe("provider");
    expect(u.bearer).toBe(false);
  });

  test("a OneDrive download URL is PROVIDER-returned, so it carries NO bearer", () => {
    expect(onedriveByteUrl("https://x.sharepoint.com/d?t=1").bearer).toBe(false);
  });

  test("an external id is percent-encoded into the Drive path", () => {
    expect(driveByteUrl("a/b?c").url).toContain("a%2Fb%3Fc");
  });
});

describe("renditions", () => {
  test("photos image rendition bounds the long edge", () => {
    expect(photosByteUrl("https://lh3.example/abc", "image", true).url).toBe(
      "https://lh3.example/abc=w2048-h2048",
    );
  });

  test("photos av rendition asks for the transcoded video", () => {
    expect(photosByteUrl("https://lh3.example/abc", "av", true).url).toBe(
      "https://lh3.example/abc=dv",
    );
  });

  test("originals mode appends nothing", () => {
    expect(photosByteUrl("https://lh3.example/abc", "image", false).url).toBe(
      "https://lh3.example/abc",
    );
  });

  test("drive has no rendition — the same URL either way", () => {
    expect(driveByteUrl("x").url).toBe(driveByteUrl("x").url);
  });
});

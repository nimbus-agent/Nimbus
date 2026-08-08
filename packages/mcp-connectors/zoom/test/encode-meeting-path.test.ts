import { describe, expect, it } from "bun:test";

import { encodeZoomMeetingPathSegment } from "../src/encode-meeting-path.ts";

describe("encodeZoomMeetingPathSegment", () => {
  it("single-encodes a plain numeric meeting id", () => {
    expect(encodeZoomMeetingPathSegment("83476203401")).toBe("83476203401");
  });

  it("single-encodes a normal base64-ish UUID", () => {
    expect(encodeZoomMeetingPathSegment("abcd1234==")).toBe("abcd1234%3D%3D");
  });

  it("double-encodes a UUID that starts with /", () => {
    expect(encodeZoomMeetingPathSegment("/abc==")).toBe(
      encodeURIComponent(encodeURIComponent("/abc==")),
    );
  });

  it("double-encodes a UUID that contains //", () => {
    expect(encodeZoomMeetingPathSegment("ab//cd")).toBe(
      encodeURIComponent(encodeURIComponent("ab//cd")),
    );
  });

  it("single-encodes a UUID that contains a single / not at the beginning", () => {
    expect(encodeZoomMeetingPathSegment("ab/cd")).toBe(
      encodeURIComponent("ab/cd"),
    );
  });

  it("handles empty string correctly", () => {
    expect(encodeZoomMeetingPathSegment("")).toBe("");
  });

  it("single-encodes other special characters", () => {
    expect(encodeZoomMeetingPathSegment("abc?def&ghi")).toBe(
      encodeURIComponent("abc?def&ghi"),
    );
  });
});

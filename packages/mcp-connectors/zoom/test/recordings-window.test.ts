import { describe, expect, it } from "bun:test";
import { validateZoomRecordingsWindow } from "../src/recordings-window.ts";

describe("validateZoomRecordingsWindow", () => {
  it("accepts a 30-day window", () => {
    expect(() =>
      validateZoomRecordingsWindow("2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z"),
    ).not.toThrow();
  });

  it("accepts a 31-day window (the documented upper bound)", () => {
    expect(() =>
      validateZoomRecordingsWindow("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z"),
    ).not.toThrow();
  });

  it("accepts a same-day zero-width window", () => {
    expect(() =>
      validateZoomRecordingsWindow("2026-05-01T00:00:00Z", "2026-05-01T00:00:00Z"),
    ).not.toThrow();
  });

  it("accepts the YYYY-MM-DD short form", () => {
    expect(() => validateZoomRecordingsWindow("2026-05-01", "2026-05-15")).not.toThrow();
  });

  it("rejects a window wider than 31 days", () => {
    expect(() =>
      validateZoomRecordingsWindow("2026-05-01T00:00:00Z", "2026-07-01T00:00:00Z"),
    ).toThrow(/<= 1 month/);
  });

  it("rejects `to < from`", () => {
    expect(() =>
      validateZoomRecordingsWindow("2026-05-31T00:00:00Z", "2026-05-01T00:00:00Z"),
    ).toThrow(/must be >= 'from'/);
  });

  it("rejects an unparseable `from`", () => {
    expect(() => validateZoomRecordingsWindow("not-a-date", "2026-05-31T00:00:00Z")).toThrow(
      /Invalid 'from'/,
    );
  });

  it("rejects an unparseable `to`", () => {
    expect(() => validateZoomRecordingsWindow("2026-05-01T00:00:00Z", "ñope")).toThrow(
      /Invalid 'to'/,
    );
  });
});

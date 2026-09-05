import { describe, expect, test } from "bun:test";
import type { GrantPreviewItem } from "./media-grants-cmd.ts";
import { parseAllowRemoteArgs, renderGrantPreview } from "./media-grants-cmd.ts";

describe("parseAllowRemoteArgs", () => {
  test("accepts explicit item ids", () => {
    expect(parseAllowRemoteArgs(["item_42", "item_43"]).itemIds).toEqual(["item_42", "item_43"]);
  });

  /**
   * § 18.5: an unbounded "grant everything" must not be EXPRESSIBLE. A selector with no --limit is
   * a refusal, not a default -- a default would be a number the user never chose.
   */
  test("REFUSES a selector form with no --limit", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos"])).toThrow(/--limit/);
  });

  test("REFUSES a --limit above the cap", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos", "--limit", "5000"])).toThrow(
      /limit/,
    );
  });

  test("REFUSES mixing explicit ids with a selector", () => {
    expect(() => parseAllowRemoteArgs(["item_1", "--service", "google_photos"])).toThrow();
  });
});

describe("renderGrantPreview", () => {
  const items: GrantPreviewItem[] = [
    {
      itemId: "i1",
      title: "chart.png",
      sizeBytes: 390_842,
      modifiedAt: 1_700_000_000_000,
      service: "google_photos",
      alreadyGranted: false,
    },
    {
      itemId: "i2",
      title: "diagram.png",
      sizeBytes: null,
      modifiedAt: 1_700_000_000_000,
      service: "google_photos",
      alreadyGranted: true,
    },
  ];

  /** § 18.5: "20 items" is a count, not consent. The preview ENUMERATES. */
  test("enumerates every artifact by title, never just a count", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toContain("chart.png");
    expect(out).toContain("diagram.png");
  });

  /**
   * § 18.5, new in PR 4: since the cloud arm shipped, approving a grant authorises a CROSS-VENDOR
   * transfer -- bytes stored with one provider sent to a different one. The preview names both ends.
   */
  test("names BOTH ends of the transfer", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toContain("source google_photos");
    expect(out).toContain("destination openai");
  });

  test("a local artifact reads 'source local'", () => {
    const first = items[0];
    if (first === undefined) throw new Error("fixture");
    const out = renderGrantPreview({
      items: [{ ...first, service: "filesystem" }],
      vendor: "openai",
    });
    expect(out).toContain("source local");
  });

  /** § 19.6: a count that silently includes rows the run did not write is a dishonest preview. */
  test("separates newly matched from already-granted", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toMatch(/1 new/);
    expect(out).toMatch(/1 already granted/);
  });
});

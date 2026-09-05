import { afterEach, describe, expect, test } from "bun:test";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { GrantPreviewItem } from "./media-grants-cmd.ts";
import {
  parseAllowRemoteArgs,
  parseGrantsRevokeArgs,
  renderGrantList,
  renderGrantPreview,
  resolveGrantCandidates,
  runAllowRemoteCmd,
} from "./media-grants-cmd.ts";

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

describe("renderGrantList", () => {
  test("names the vendor per grant — the whole point is which third party may see what", () => {
    const out = renderGrantList([
      { itemId: "i1", title: "chart.png", modelVendor: "openai", grantedAt: 1_700_000_000_000 },
    ]);
    expect(out).toContain("openai");
    expect(out).toContain("chart.png");
  });

  test("an empty list says so plainly rather than printing a bare header", () => {
    expect(renderGrantList([])).toMatch(/no active grants/i);
  });
});

describe("parseGrantsRevokeArgs", () => {
  test("--vendor narrows the revocation; without it every vendor's grant on the item goes", () => {
    expect(parseGrantsRevokeArgs(["i1", "--vendor", "openai"]).modelVendor).toBe("openai");
    expect(parseGrantsRevokeArgs(["i1"]).modelVendor).toBeUndefined();
  });

  test("REFUSES with no item id rather than revoking everything", () => {
    expect(() => parseGrantsRevokeArgs([])).toThrow();
  });
});

/**
 * The Critical from review: an explicit item id outside the scan window used to be silently
 * defaulted to `service: "unknown"`, which `renderGrantPreview`'s `sourceLabel` then rendered as
 * "source local" for a photo that might actually live in Google Photos. A consent preview must
 * never assert a source it cannot substantiate, so an unresolved id is now reported separately
 * rather than turned into a fabricated row at all.
 */
describe("resolveGrantCandidates", () => {
  afterEach(() => clearFixture());

  test("marks an id outside the scan window as unresolved, never defaulting it to local", async () => {
    const ipc = createMockIpcClient([{ items: [], meta: { limit: 1000, total: 0 } }]);
    const result = await resolveGrantCandidates(ipc.client, { itemIds: ["missing-id"] });
    expect(result.unresolvedIds).toEqual(["missing-id"]);
    expect(result.rows).toEqual([]);
  });

  test("resolves an id the scan DOES find, and scopes the scan to media services/types", async () => {
    const ipc = createMockIpcClient([
      {
        items: [
          {
            indexPrimaryKey: "i1",
            name: "chart.png",
            service: "google_photos",
            sizeBytes: 100,
            modifiedAt: 42,
          },
        ],
        meta: { limit: 1000, total: 1 },
      },
    ]);
    const result = await resolveGrantCandidates(ipc.client, { itemIds: ["i1"] });
    expect(result.unresolvedIds).toEqual([]);
    expect(result.rows).toEqual([
      {
        itemId: "i1",
        title: "chart.png",
        sizeBytes: 100,
        modifiedAt: 42,
        service: "google_photos",
      },
    ]);
    const call = ipc.calls[0];
    expect(call?.method).toBe("index.queryItems");
    const params = call?.params as { services?: string[]; types?: string[] };
    // Scoped to media-bearing services/types, never the whole index — this is what keeps
    // ordinary unrelated activity from evicting the target out of the scan window.
    expect(params.services).toContain("google_photos");
    expect(params.services).not.toBeUndefined();
    expect(params.types).not.toBeUndefined();
  });
});

describe("runAllowRemoteCmd", () => {
  afterEach(() => clearFixture());

  test("REFUSES to preview or grant when any explicit item id could not be resolved", async () => {
    const ipc = createMockIpcClient([
      // index.queryItems: only "i1" is found; "missing-id" is not in the scan.
      {
        items: [
          {
            indexPrimaryKey: "i1",
            name: "chart.png",
            service: "google_photos",
            sizeBytes: 100,
            modifiedAt: 42,
          },
        ],
        meta: { limit: 1000, total: 1 },
      },
      // media.grants.list, fetched in parallel with the scan above.
      { grants: [] },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    await expect(runAllowRemoteCmd(["i1", "missing-id", "--vendor", "openai"])).rejects.toThrow(
      /missing-id/,
    );

    // The refusal must happen before any write: media.allowRemote is never called.
    expect(ipc.calls.some((c) => c.method === "media.allowRemote")).toBe(false);
  });
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { GrantPreviewItem } from "./media-grants-cmd.ts";
import {
  MAX_GRANT_LIMIT,
  parseAllowRemoteArgs,
  parseGrantsRevokeArgs,
  renderGrantList,
  renderGrantPreview,
  resolveGrantCandidates,
  runAllowRemoteCmd,
  runGrantsCmd,
} from "./media-grants-cmd.ts";

const out = captureOutput();
afterAll(() => out.restore());

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

  test("REFUSES --service with no value", () => {
    expect(() => parseAllowRemoteArgs(["--service"])).toThrow(/--service requires a value/);
  });

  test("REFUSES --since with no value", () => {
    expect(() => parseAllowRemoteArgs(["--since"])).toThrow(/--since requires a value/);
  });

  test("REFUSES a negative --since", () => {
    expect(() => parseAllowRemoteArgs(["--since", "-1", "--limit", "5"])).toThrow(
      /--since must be a non-negative number/,
    );
  });

  test("REFUSES a non-numeric --since", () => {
    expect(() => parseAllowRemoteArgs(["--since", "abc", "--limit", "5"])).toThrow(
      /--since must be a non-negative number/,
    );
  });

  test("REFUSES --limit with no value", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos", "--limit"])).toThrow(
      /--limit requires a value/,
    );
  });

  test("REFUSES a non-integer --limit", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos", "--limit", "3.5"])).toThrow(
      /--limit must be a positive integer/,
    );
  });

  test("REFUSES a zero --limit", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos", "--limit", "0"])).toThrow(
      /--limit must be a positive integer/,
    );
  });

  test("REFUSES an unknown flag", () => {
    expect(() => parseAllowRemoteArgs(["--bogus"])).toThrow(/unknown flag/);
  });

  test("skips a blank positional argument rather than treating it as an item id", () => {
    // The blank string must not become an itemId (which would put the parser into the explicit
    // form and make --service/--limit below an illegal mix).
    expect(parseAllowRemoteArgs(["", "--service", "google_photos", "--limit", "5"])).toEqual({
      itemIds: [],
      service: "google_photos",
      limit: 5,
    });
  });

  test("selector form carries --service, --since AND --limit together", () => {
    const parsed = parseAllowRemoteArgs([
      "--service",
      "google_photos",
      "--since",
      "7",
      "--limit",
      "10",
    ]);
    expect(parsed).toEqual({ itemIds: [], service: "google_photos", sinceDays: 7, limit: 10 });
  });

  test("selector form with only --limit omits service and sinceDays entirely", () => {
    const parsed = parseAllowRemoteArgs(["--limit", "10"]);
    expect(parsed).toEqual({ itemIds: [], limit: 10 });
    expect("service" in parsed).toBe(false);
    expect("sinceDays" in parsed).toBe(false);
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

  test("a grant whose source item left the index shows a placeholder, not a blank title", () => {
    const out = renderGrantList([
      { itemId: "i1", title: null, modelVendor: "openai", grantedAt: 1_700_000_000_000 },
    ]);
    expect(out).toContain("(item no longer indexed)");
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

  test("REFUSES --vendor with no value", () => {
    expect(() => parseGrantsRevokeArgs(["i1", "--vendor"])).toThrow(/--vendor requires a value/);
  });

  test("REFUSES an unknown flag", () => {
    expect(() => parseGrantsRevokeArgs(["i1", "--bogus"])).toThrow(/unknown flag/);
  });

  test("only the FIRST positional argument is taken as the item id", () => {
    expect(parseGrantsRevokeArgs(["i1", "i2"]).itemId).toBe("i1");
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

  test("falls back to the item's external `id` field when indexPrimaryKey is absent", async () => {
    const ipc = createMockIpcClient([
      {
        items: [{ id: "i1", title: "diagram.png", service: "onedrive", modifiedAt: 5 }],
        meta: { limit: 1000, total: 1 },
      },
    ]);
    const result = await resolveGrantCandidates(ipc.client, { itemIds: ["i1"] });
    expect(result.rows).toEqual([
      { itemId: "i1", title: "diagram.png", sizeBytes: null, modifiedAt: 5, service: "onedrive" },
    ]);
  });

  test("silently drops a scanned row missing itemId/title/service rather than throwing", async () => {
    const ipc = createMockIpcClient([
      {
        // No indexPrimaryKey/id, and a raw non-object entry too — both must be dropped, not thrown.
        items: [
          { name: "no-id.png", service: "google_photos" },
          "not-an-object",
          { indexPrimaryKey: "i2", name: "no-service.png" }, // missing `service`
          { indexPrimaryKey: "i1", title: "chart.png", service: "google_photos" }, // title fallback
        ],
        meta: { limit: 1000, total: 4 },
      },
    ]);
    const result = await resolveGrantCandidates(ipc.client, { itemIds: ["i1"] });
    expect(result.rows).toEqual([
      {
        itemId: "i1",
        title: "chart.png",
        sizeBytes: null,
        modifiedAt: 0,
        service: "google_photos",
      },
    ]);
  });

  test("a non-array `items` field in the response resolves to zero candidates", async () => {
    const ipc = createMockIpcClient([{ items: "not-an-array", meta: { limit: 1000, total: 0 } }]);
    const result = await resolveGrantCandidates(ipc.client, { itemIds: ["i1"] });
    expect(result.rows).toEqual([]);
    expect(result.unresolvedIds).toEqual(["i1"]);
  });

  test("selector form with BOTH --service and --since sets services and sinceMs", async () => {
    const ipc = createMockIpcClient([{ items: [], meta: { limit: 5, total: 0 } }]);
    await resolveGrantCandidates(ipc.client, {
      itemIds: [],
      service: "google_drive",
      sinceDays: 7,
      limit: 5,
    });
    const params = ipc.calls[0]?.params as {
      services?: string[];
      sinceMs?: number;
      limit: number;
    };
    expect(params.services).toEqual(["google_drive"]);
    expect(typeof params.sinceMs).toBe("number");
    expect(params.limit).toBe(5);
  });

  test("selector form with NEITHER --service nor --since omits both params", async () => {
    const ipc = createMockIpcClient([{ items: [], meta: { limit: 5, total: 0 } }]);
    await resolveGrantCandidates(ipc.client, { itemIds: [], limit: 5 });
    const params = ipc.calls[0]?.params as Record<string, unknown>;
    expect("services" in params).toBe(false);
    expect("sinceMs" in params).toBe(false);
    expect(params["limit"]).toBe(5);
  });

  test("selector form with no --limit at all defaults the IPC request to MAX_GRANT_LIMIT", async () => {
    // Bypasses parseAllowRemoteArgs (which always sets `limit` in selector form) to exercise
    // resolveGrantCandidates's own defensive `parsed.limit ?? MAX_GRANT_LIMIT` fallback directly.
    const ipc = createMockIpcClient([{ items: [], meta: { limit: MAX_GRANT_LIMIT, total: 0 } }]);
    await resolveGrantCandidates(ipc.client, { itemIds: [] });
    const params = ipc.calls[0]?.params as { limit: number };
    expect(params.limit).toBe(MAX_GRANT_LIMIT);
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

  test("pluralizes the refusal message when MULTIPLE explicit item ids could not be resolved", async () => {
    const ipc = createMockIpcClient([
      { items: [], meta: { limit: 1000, total: 0 } },
      { grants: [] },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    await expect(
      runAllowRemoteCmd(["missing-1", "missing-2", "--vendor", "openai"]),
    ).rejects.toThrow(/2 item ids \(missing-1, missing-2\)/);
  });

  test("REFUSES --vendor entirely missing", async () => {
    // Fails inside extractVendorFlag, before withGatewayIpc ever runs — no fixture needed.
    await expect(runAllowRemoteCmd(["item_1"])).rejects.toThrow(/--vendor.*required/);
  });

  test("REFUSES a --vendor flag with no value", async () => {
    await expect(runAllowRemoteCmd(["item_1", "--vendor"])).rejects.toThrow(
      /--vendor requires a value/,
    );
  });

  test("REFUSES to grant without confirmation in non-TTY mode, once candidates DO resolve", async () => {
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
      { grants: [] },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    await expect(runAllowRemoteCmd(["i1", "--vendor", "openai"])).rejects.toThrow(
      /refusing to grant without confirmation in non-TTY mode/,
    );
    expect(ipc.calls.some((c) => c.method === "media.allowRemote")).toBe(false);
  });

  test("selector form with zero matching candidates reports nothing to grant, without prompting", async () => {
    const ipc = createMockIpcClient([
      { items: [], meta: { limit: 5, total: 0 } }, // index.queryItems
      { grants: [] }, // media.grants.list
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();

    await runAllowRemoteCmd(["--service", "google_photos", "--limit", "5", "--vendor", "openai"]);

    expect(out.stdout).toContain("No matching artifacts found");
    expect(ipc.calls.map((c) => c.method)).toEqual(["index.queryItems", "media.grants.list"]);
  });

  test("TTY 'y' answer grants a single item, using singular phrasing, and calls media.allowRemote", async () => {
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
      { grants: [] },
      { granted: 1, alreadyGranted: 0 },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("y\n");
    out.reset();
    try {
      await runAllowRemoteCmd(["i1", "--vendor", "openai"]);
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }

    expect(out.stdout).toContain("Granted 1 new, 0 already granted.");
    const write = ipc.calls.find((c) => c.method === "media.allowRemote");
    expect(write?.params).toEqual({ itemIds: ["i1"], vendor: "openai" });
  });

  test("TTY 'n' answer aborts a multi-item grant without calling media.allowRemote, and distinguishes already-granted-by-a-DIFFERENT-vendor from a real match", async () => {
    const ipc = createMockIpcClient([
      {
        items: [
          { indexPrimaryKey: "i1", name: "chart.png", service: "google_photos", modifiedAt: 1 },
          { indexPrimaryKey: "i2", name: "diagram.png", service: "google_photos", modifiedAt: 2 },
        ],
        meta: { limit: 1000, total: 2 },
      },
      // i1 already granted to "openai" (the vendor we're granting now); i2 granted only to a
      // DIFFERENT vendor, which must NOT count as already-granted for this run.
      {
        grants: [
          { itemId: "i1", title: "chart.png", modelVendor: "openai", grantedAt: 1 },
          { itemId: "i2", title: "diagram.png", modelVendor: "anthropic", grantedAt: 2 },
        ],
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("n\n");
    out.reset();
    try {
      await runAllowRemoteCmd(["i1", "i2", "--vendor", "openai"]);
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }

    expect(out.stdout).toContain("1 new, 1 already granted");
    expect(out.stdout).toContain("Aborted.");
    expect(ipc.calls.some((c) => c.method === "media.allowRemote")).toBe(false);
  });

  test("REFUSES a malformed media.allowRemote response", async () => {
    const ipc = createMockIpcClient([
      {
        items: [{ indexPrimaryKey: "i1", name: "chart.png", service: "google_photos" }],
        meta: { limit: 1000, total: 1 },
      },
      { grants: [] },
      { alreadyGranted: 0 }, // missing `granted`
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("y\n");
    try {
      await expect(runAllowRemoteCmd(["i1", "--vendor", "openai"])).rejects.toThrow(
        /malformed media\.allowRemote response/,
      );
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
  });

  test("REFUSES a media.allowRemote response missing only `alreadyGranted`", async () => {
    const ipc = createMockIpcClient([
      {
        items: [{ indexPrimaryKey: "i1", name: "chart.png", service: "google_photos" }],
        meta: { limit: 1000, total: 1 },
      },
      { grants: [] },
      { granted: 1 }, // missing `alreadyGranted`
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): Buffer => Buffer.from("y\n");
    try {
      await expect(runAllowRemoteCmd(["i1", "--vendor", "openai"])).rejects.toThrow(
        /malformed media\.allowRemote response/,
      );
    } finally {
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
  });

  test("readAnswer() waits for a 'data' event when read() first returns null (TTY, no buffered input yet)", async () => {
    const ipc = createMockIpcClient([
      {
        items: [{ indexPrimaryKey: "i1", name: "chart.png", service: "google_photos" }],
        meta: { limit: 1000, total: 1 },
      },
      { grants: [] },
      { granted: 1, alreadyGranted: 0 },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    const origIsTTY = process.stdin.isTTY;
    const origRead = process.stdin.read.bind(process.stdin);
    process.stdin.isTTY = true;
    process.stdin.read = (): null => null;
    const emitTimer = setTimeout(() => {
      process.stdin.emit("data", Buffer.from("yes\n"));
    }, 20);
    out.reset();
    try {
      await runAllowRemoteCmd(["i1", "--vendor", "openai"]);
    } finally {
      clearTimeout(emitTimer);
      process.stdin.isTTY = origIsTTY;
      process.stdin.read = origRead;
    }
    expect(out.stdout).toContain("Granted 1 new, 0 already granted.");
  });
});

describe("runGrantsCmd", () => {
  afterEach(() => clearFixture());

  test("REFUSES an unknown subcommand", async () => {
    await expect(runGrantsCmd(["bogus"])).rejects.toThrow(/unknown subcommand "bogus"/);
  });

  test("REFUSES with no subcommand at all", async () => {
    await expect(runGrantsCmd([])).rejects.toThrow(/unknown subcommand ""/);
  });

  test("'list' prints every grant, substituting a placeholder for a null title", async () => {
    const ipc = createMockIpcClient([
      {
        grants: [
          { itemId: "i1", title: "chart.png", modelVendor: "openai", grantedAt: 1 },
          { itemId: "i2", title: null, modelVendor: "anthropic", grantedAt: 2 },
        ],
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();

    await runGrantsCmd(["list"]);

    expect(out.stdout).toContain("chart.png");
    expect(out.stdout).toContain("(item no longer indexed)");
  });

  test("'list' drops a malformed grant entry and tolerates a missing `grants` array", async () => {
    const ipc = createMockIpcClient([
      {
        grants: [
          { itemId: "i1", title: "ok.png" /* missing modelVendor/grantedAt */ },
          { title: "no-item-id.png", modelVendor: "openai", grantedAt: 3 } /* missing itemId */,
          { itemId: "i2", title: "good.png", modelVendor: "openai", grantedAt: 2 },
        ],
      },
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();
    await runGrantsCmd(["list"]);
    expect(out.stdout).toContain("good.png");
    expect(out.stdout).not.toContain("ok.png");

    const ipc2 = createMockIpcClient([{}]); // no `grants` field at all
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc2.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();
    await runGrantsCmd(["list"]);
    expect(out.stdout).toMatch(/no active grants/i);
  });

  test("'revoke' with --vendor narrows the request and reports the count with correct pluralization", async () => {
    const ipc = createMockIpcClient([{ revoked: 1 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();

    await runGrantsCmd(["revoke", "i1", "--vendor", "openai"]);

    expect(ipc.calls[0]).toEqual({
      method: "media.grants.revoke",
      params: { itemId: "i1", modelVendor: "openai" },
    });
    expect(out.stdout).toContain("Revoked 1 grant.");
  });

  test("'revoke' with no --vendor omits modelVendor from the request", async () => {
    const ipc = createMockIpcClient([{ revoked: 2 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    out.reset();

    await runGrantsCmd(["revoke", "i1"]);

    expect(ipc.calls[0]?.params).toEqual({ itemId: "i1" });
    expect(out.stdout).toContain("Revoked 2 grants.");
  });

  test("REFUSES a malformed media.grants.revoke response", async () => {
    const ipc = createMockIpcClient([{}]); // missing `revoked`
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });

    await expect(runGrantsCmd(["revoke", "i1"])).rejects.toThrow(
      /malformed media\.grants\.revoke response/,
    );
  });
});

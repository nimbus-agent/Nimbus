import { afterEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey } from "../index/item-store.ts";
import {
  createOAuthConnectorTestSetup,
  expectPrefixedCursorCodecRoundTrip,
  registerGlobalFetchRestore,
  requestUrlString,
} from "../testing/bun-test-support.ts";
import {
  createOneDriveSyncable,
  decodeOneDriveSyncCursor,
  encodeOneDriveSyncCursor,
  type OneDriveSyncCursorV1,
} from "./onedrive-sync.ts";

type FetchInput = string | URL | Request;

describe("OneDrive sync cursor codec", () => {
  test("round-trip", () => {
    const samples: OneDriveSyncCursorV1[] = [
      { v: 1, nextUrl: null },
      { v: 1, nextUrl: "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x" },
    ];
    expectPrefixedCursorCodecRoundTrip(
      samples,
      encodeOneDriveSyncCursor,
      decodeOneDriveSyncCursor,
      "nimbus-odrv1:",
    );
  });
});

describe("createOneDriveSyncable", () => {
  registerGlobalFetchRestore(afterEach);

  test("upserts file items and stores deltaLink cursor", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "f1",
                name: "doc.txt",
                file: { mimeType: "text/plain" },
                webUrl: "https://example.com/f1",
                lastModifiedDateTime: "2024-03-01T12:00:00Z",
                lastModifiedBy: {
                  user: { displayName: "Pat", mail: "pat@example.com" },
                },
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=done",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.hasMore).toBe(false);
    expect(r.cursor).not.toBeNull();

    const row = db
      .query("SELECT service, type, external_id, author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "f1")) as
      | { service: string; type: string; external_id: string; author_id: string | null }
      | undefined;
    expect(row?.type).toBe("file");
    expect(row?.external_id).toBe("f1");
    expect(row?.author_id).not.toBeNull();
  });

  test("folder item: sets type=folder, url=null when webUrl missing", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "folder1",
                folder: {},
                // no name → fallback to item_folder1
                // no webUrl → url=null
                lastModifiedDateTime: "2024-05-01T00:00:00Z",
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(1);

    const row = db
      .query("SELECT type, url FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "folder1")) as
      | { type: string; url: string | null }
      | undefined;
    expect(row?.type).toBe("folder");
    expect(row?.url).toBeNull();
  });

  test("item with no id is skipped — no DB row written (L66 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              { name: "orphan.txt" }, // no id
              { id: "", name: "empty-id.txt" }, // empty id → guard also fires
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    // upsertDriveItem is called but returns early for both items, so no rows in DB
    const count = db.query("SELECT COUNT(*) as c FROM item WHERE service = ?").get("onedrive") as {
      c: number;
    };
    expect(count.c).toBe(0);
  });

  test("title fallback to item_<id> when name is missing (L69 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "nname1" }, // no name field
              { id: "nname2", name: "" }, // empty name
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row1 = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "nname1")) as { title: string } | undefined;
    expect(row1?.title).toBe("item_nname1");

    const row2 = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "nname2")) as { title: string } | undefined;
    expect(row2?.title).toBe("item_nname2");
  });

  test("title is truncated to 512 chars when name exceeds 512 (L102 branch)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });
    const longName = "a".repeat(600);

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "longname1", name: longName }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await syncable.sync(ctx, null);

    const row = db
      .query("SELECT title FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "longname1")) as { title: string } | undefined;
    expect(row?.title).toHaveLength(512);
  });

  test("file mimeType is undefined when file field is array (L77 branch)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "arr1", name: "arr.bin", file: [] }, // array → mimeType=undefined
              { id: "nf1", name: "nofile.bin" }, // no file field → mimeType=undefined
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(2);
  });

  test("authorId is null when lastModifiedBy has no usable email (L93 displayName fallback and null path)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "noauth1",
                name: "file.txt",
                // no lastModifiedBy → authorId = null
              },
              {
                id: "noauth2",
                name: "file2.txt",
                lastModifiedBy: {
                  user: { displayName: "No Email User" }, // no email/mail/userPrincipalName
                },
              },
              {
                id: "noauth3",
                name: "file3.txt",
                lastModifiedBy: {
                  user: {
                    // displayName is empty → fallback to email as displayName
                    displayName: "",
                    mail: "noname@example.com",
                  },
                },
              },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(3);

    const row1 = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "noauth1")) as { author_id: string | null } | undefined;
    expect(row1?.author_id).toBeNull();

    const row2 = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "noauth2")) as { author_id: string | null } | undefined;
    expect(row2?.author_id).toBeNull();

    // noauth3 has a valid email so author_id should be set
    const row3 = db
      .query("SELECT author_id FROM item WHERE id = ?")
      .get(itemPrimaryKey("onedrive", "noauth3")) as { author_id: string | null } | undefined;
    expect(row3?.author_id).not.toBeNull();
  });

  test("invalid cursor is treated as initial fetch (L131 branch)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    let capturedUrl = "";
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      capturedUrl = url;
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    // Pass a cursor that has the wrong prefix (decode returns undefined)
    const r = await syncable.sync(ctx, "nimbus-wrong-prefix:garbage");
    // Should succeed and fall back to the initial URL
    expect(r.itemsUpserted).toBe(0);
    expect(capturedUrl).toContain("/drive/root/delta");
  });

  test("empty value array when page has no value field (L142 branch)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            // no value field at all
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=x",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r = await syncable.sync(ctx, null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.itemsDeleted).toBe(0);
  });

  test("pagination: nextLink sets hasMore=true, uses nextLink on second call (L129/nextLink branch)", async () => {
    const { ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (url.includes("token=page2")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "p2", name: "page2.txt", file: {} }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=done",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/drive/root/delta")) {
        return new Response(
          JSON.stringify({
            value: [{ id: "p1", name: "page1.txt", file: {} }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=page2",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const r1 = await syncable.sync(ctx, null);
    expect(r1.itemsUpserted).toBe(1);
    expect(r1.hasMore).toBe(true);
    expect(r1.cursor).not.toBeNull();

    // second page: resume with the cursor
    const r2 = await syncable.sync(ctx, r1.cursor ?? "");
    expect(r2.itemsUpserted).toBe(1);
    expect(r2.hasMore).toBe(false);
  });

  test("deleted.state='deleted' arm removes item with id (L155-L156 branches)", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    let call = 0;
    globalThis.fetch = (async (input: FetchInput) => {
      const url = requestUrlString(input);
      if (!url.includes("/drive/root/delta") && !url.includes("graph.example")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      call += 1;
      if (call === 1) {
        // seed the item
        return new Response(
          JSON.stringify({
            value: [{ id: "del1", name: "soon-gone.txt", file: {} }],
            "@odata.deltaLink": "https://graph.example/delta",
          }),
          { status: 200 },
        );
      }
      // second call: mark as deleted via deleted.state
      return new Response(
        JSON.stringify({
          value: [
            { id: "del1", deleted: { state: "deleted" } },
            // item with no id in deleted branch → skipped
            { deleted: { state: "deleted" } },
          ],
          "@odata.deltaLink": "https://graph.example/delta2",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const afterInsert = db
      .query("SELECT COUNT(*) as c FROM item WHERE service = ?")
      .get("onedrive") as { c: number };
    expect(afterInsert.c).toBe(1);

    const r2 = await syncable.sync(
      ctx,
      encodeOneDriveSyncCursor({ v: 1, nextUrl: "https://graph.example/delta" }),
    );
    expect(r2.itemsDeleted).toBe(1);
    const afterDelete = db
      .query("SELECT COUNT(*) as c FROM item WHERE service = ?")
      .get("onedrive") as { c: number };
    expect(afterDelete.c).toBe(0);
  });

  test("deletes when @removed present", async () => {
    const { db, ctx } = await createOAuthConnectorTestSetup("microsoft", "onedrive");
    const syncable = createOneDriveSyncable({ ensureMicrosoftMcpRunning: async () => {} });

    let call = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = requestUrlString(input);
      if (!url.includes("/drive/root/delta") && !url.includes("graph.example")) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({
            value: [
              { id: "x1", name: "a", file: {}, lastModifiedDateTime: "2024-01-01T00:00:00Z" },
            ],
            "@odata.deltaLink": "https://graph.example/delta",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          value: [{ id: "x1", "@removed": { reason: "deleted" } }],
          "@odata.deltaLink": "https://graph.example/delta2",
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await syncable.sync(ctx, null);
    const afterInsert = db
      .query("SELECT COUNT(*) as c FROM item WHERE service = ?")
      .get("onedrive") as { c: number };
    expect(afterInsert.c).toBe(1);

    const r2 = await syncable.sync(
      ctx,
      encodeOneDriveSyncCursor({ v: 1, nextUrl: "https://graph.example/delta" }),
    );
    expect(r2.itemsDeleted).toBe(1);
    const afterDelete = db
      .query("SELECT COUNT(*) as c FROM item WHERE service = ?")
      .get("onedrive") as { c: number };
    expect(afterDelete.c).toBe(0);
  });
});

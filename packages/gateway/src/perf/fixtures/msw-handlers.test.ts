import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupServer } from "msw/node";
import { driveHandlers, githubHandlers, gmailHandlers } from "./msw-handlers.ts";

describe("driveHandlers", () => {
  const server = setupServer(...driveHandlers("small"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...driveHandlers("small")));
  afterAll(() => server.close());

  test("first page returns files + nextPageToken", async () => {
    const r = await fetch("https://www.googleapis.com/drive/v3/files");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: unknown[]; nextPageToken?: string };
    expect(body.files).toHaveLength(50);
    expect(body.nextPageToken).toBeUndefined();
  });
});

describe("gmailHandlers", () => {
  const server = setupServer(...gmailHandlers("small"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...gmailHandlers("small")));
  afterAll(() => server.close());

  test("messages.list returns paginated ids", async () => {
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    expect(r.status).toBe(200);
    const body = (await r.json()) as { messages: { id: string }[] };
    expect(body.messages.length).toBeGreaterThan(0);
  });

  test("messages.get returns the full payload for a known id", async () => {
    const list = (await (
      await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages")
    ).json()) as { messages: { id: string }[] };
    const id = list.messages[0]?.id;
    expect(id).toBeTruthy();
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    expect(r.status).toBe(200);
    const m = (await r.json()) as { snippet: string };
    expect(typeof m.snippet).toBe("string");
  });
});

describe("githubHandlers", () => {
  const server = setupServer(...githubHandlers("small"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...githubHandlers("small")));
  afterAll(() => server.close());

  test("pulls list returns array + Link header on multi-page", async () => {
    const r = await fetch("https://api.github.com/repos/example/repo/pulls?per_page=100&page=1");
    expect(r.status).toBe(200);
    const body = (await r.json()) as unknown[];
    expect(body).toHaveLength(50);
    // A single-page tier has nowhere to link to, so the handler sends NO Link header at all —
    // an empty `Link: ""` would read as a malformed header to a connector parsing RFC 5988.
    expect(r.headers.get("link")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-page tiers. `small` (50 records) fits on one page for every service, so the page-token /
// page-number arithmetic below is only reachable from `medium` (500 records = 5 pages of 100).
// ---------------------------------------------------------------------------

describe("driveHandlers — medium tier pagination", () => {
  const server = setupServer(...driveHandlers("medium"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...driveHandlers("medium")));
  afterAll(() => server.close());

  type DriveBody = { files: { name: string }[]; nextPageToken?: string };
  const list = async (query: string): Promise<DriveBody> => {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files${query}`);
    expect(r.status).toBe(200);
    return (await r.json()) as DriveBody;
  };

  test("a page token resolves to the page holding that file offset", async () => {
    const body = await list("?pageToken=tok-drive-medium-200");
    expect(body.files).toHaveLength(100);
    expect(body.files[0]?.name).toBe("synthetic-drive-medium-200.dat");
    expect(body.nextPageToken).toBe("tok-drive-medium-300");
  });

  test("the last page carries no nextPageToken", async () => {
    const body = await list("?pageToken=tok-drive-medium-400");
    expect(body.files[0]?.name).toBe("synthetic-drive-medium-400.dat");
    expect(body.nextPageToken).toBeUndefined();
  });

  test("a token past the end answers an empty page rather than an error", async () => {
    expect(await list("?pageToken=tok-drive-medium-900")).toEqual({ files: [] });
  });

  test("an unrecognised token (here: Gmail's shape) falls back to the first page", async () => {
    const body = await list("?pageToken=tok-gmail-medium-200");
    expect(body.files[0]?.name).toBe("synthetic-drive-medium-0.dat");
    expect(body.nextPageToken).toBe("tok-drive-medium-100");
  });
});

describe("gmailHandlers — medium tier pagination and lookups", () => {
  const server = setupServer(...gmailHandlers("medium"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...gmailHandlers("medium")));
  afterAll(() => server.close());

  const BASE = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  type ListBody = {
    messages: { id: string }[];
    nextPageToken?: string;
    resultSizeEstimate: number;
  };
  const list = async (query: string): Promise<ListBody> => {
    const r = await fetch(`${BASE}${query}`);
    expect(r.status).toBe(200);
    return (await r.json()) as ListBody;
  };
  const idAt = (i: number): string => `gmail-medium-${i.toString(36).padStart(8, "0")}`;

  test("a page token resolves to the page holding that message offset", async () => {
    const body = await list("?pageToken=tok-gmail-medium-100");
    expect(body.messages).toHaveLength(100);
    expect(body.messages[0]?.id).toBe(idAt(100));
    expect(body.nextPageToken).toBe("tok-gmail-medium-200");
    expect(body.resultSizeEstimate).toBe(500);
  });

  test("a token past the end answers an empty list with a zero estimate", async () => {
    expect(await list("?pageToken=tok-gmail-medium-700")).toEqual({
      messages: [],
      resultSizeEstimate: 0,
    });
  });

  test("an unrecognised token (here: Drive's shape) falls back to the first page", async () => {
    const body = await list("?pageToken=tok-drive-medium-100");
    expect(body.messages[0]?.id).toBe(idAt(0));
    expect(body.nextPageToken).toBe("tok-gmail-medium-100");
  });

  test("messages.get answers 404 for an id outside the tier and for a foreign id shape", async () => {
    // Index 500 is one past the medium tier's last message.
    const outOfTier = await fetch(`${BASE}/${idAt(500)}`);
    expect(outOfTier.status).toBe(404);
    const foreign = await fetch(`${BASE}/not-a-gmail-id`);
    expect(foreign.status).toBe(404);
    // Control: the boundary id just inside the tier still resolves.
    const last = await fetch(`${BASE}/${idAt(499)}`);
    expect(last.status).toBe(200);
    expect(((await last.json()) as { id: string }).id).toBe(idAt(499));
  });
});

describe("githubHandlers — medium tier pagination", () => {
  const server = setupServer(...githubHandlers("medium"));
  beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
  afterEach(() => server.resetHandlers(...githubHandlers("medium")));
  afterAll(() => server.close());

  const BASE = "https://api.github.com/repos/example/repo/pulls";
  const linkRels = (link: string | null): string[] =>
    (link ?? "")
      .split(", ")
      .filter((p) => p !== "")
      .map((p) => /rel="([a-z]+)"/.exec(p)?.[1] ?? "?");

  test("a middle page links prev/first/next/last and serves that page's slice", async () => {
    const r = await fetch(`${BASE}?page=2&per_page=100`);
    const body = (await r.json()) as { number: number }[];
    expect(body).toHaveLength(100);
    expect(body[0]?.number).toBe(101);
    expect(linkRels(r.headers.get("link"))).toEqual(["prev", "first", "next", "last"]);
  });

  test("with no query params the page defaults to 1 and per_page to 100", async () => {
    const r = await fetch(BASE);
    const body = (await r.json()) as { number: number }[];
    expect(body[0]?.number).toBe(1);
    const link = r.headers.get("link") ?? "";
    expect(linkRels(link)).toEqual(["next", "last"]);
    expect(link).toContain("page=2&per_page=100");
    expect(link).toContain("page=5&per_page=100");
  });

  test("a page past the end answers an empty slice that still links back", async () => {
    const r = await fetch(`${BASE}?page=9&per_page=100`);
    expect((await r.json()) as unknown[]).toEqual([]);
    expect(linkRels(r.headers.get("link"))).toEqual(["prev", "first"]);
  });
});

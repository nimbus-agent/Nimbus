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
  });
});

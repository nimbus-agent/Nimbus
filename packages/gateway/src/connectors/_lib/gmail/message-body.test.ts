import { expect, test } from "bun:test";

import { gmailMessageBodyText } from "./message-body.ts";

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");

test("prefers text/plain over a sibling text/html", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("plain wins") } },
        { mimeType: "text/html", body: { data: b64url("<p>html loses</p>") } },
      ],
    }),
  ).toBe("plain wins");
});

test("falls back to text/html and strips it", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "text/html",
      body: { data: b64url("<p>hello <b>there</b></p>") },
    }),
  ).toBe("hello there");
});

test("resolves nested multipart/alternative inside multipart/mixed", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64url("nested") } }],
        },
      ],
    }),
  ).toBe("nested");
});

test("decodes base64url, not plain base64", () => {
  // Chosen so the encoding contains - and _ , which plain base64 would reject
  // or mis-decode.
  const text = "a??b>>c~~d";
  const encoded = Buffer.from(text, "utf8").toString("base64url");
  expect(encoded).toMatch(/[-_]/);
  expect(gmailMessageBodyText({ mimeType: "text/plain", body: { data: encoded } })).toBe(text);
});

test("skips a part carrying an attachmentId", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { attachmentId: "att-1" } },
        { mimeType: "text/plain", body: { data: b64url("real body") } },
      ],
    }),
  ).toBe("real body");
});

test("returns empty for a payload with no usable part", () => {
  expect(gmailMessageBodyText({ mimeType: "image/png" })).toBe("");
});

test("concatenates sequential text/plain parts in multipart/mixed", () => {
  // multipart/mixed is a SEQUENCE, not alternatives — dropping all but the
  // first would silently truncate the body.
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("first half") } },
        { mimeType: "image/png", body: { attachmentId: "att-1" } },
        { mimeType: "text/plain", body: { data: b64url("second half") } },
      ],
    }),
  ).toBe("first half\nsecond half");
});

test("multipart/alternative picks ONE representation, it does not concatenate", () => {
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("chosen") } },
        { mimeType: "text/plain", body: { data: b64url("not chosen") } },
      ],
    }),
  ).toBe("chosen");
});

test("bounded: a pathological deep tree does not hang", () => {
  let node: Record<string, unknown> = { mimeType: "text/plain", body: { data: b64url("deep") } };
  for (let i = 0; i < 200; i++) {
    node = { mimeType: "multipart/mixed", parts: [node] };
  }
  expect(() => gmailMessageBodyText(node as never)).not.toThrow();
});

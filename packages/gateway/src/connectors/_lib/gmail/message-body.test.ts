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

test("multipart/alternative prefers text/plain by TYPE, even when text/html is listed first", () => {
  // A sender is free to order the alternative parts either way. Preferring
  // whichever comes first by document position would silently prefer the
  // lossy html->text conversion on exactly these messages — the opposite of
  // the documented "prefer text/plain" contract.
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>html loses</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain wins") } },
      ],
    }),
  ).toBe("plain wins");
});

test("multipart/alternative with no plain child anywhere falls back to the first html child", () => {
  // Exercises the htmlChild fallback inside the alternative branch directly
  // (not just gmailMessageBodyText's own top-level html fallback), for a
  // group where NO child produced plain text at all.
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>first html</p>") } },
        { mimeType: "text/html", body: { data: b64url("<p>second html</p>") } },
      ],
    }),
  ).toBe("first html");
});

test("multipart/alternative where no child produces plain or html text returns empty", () => {
  // Completes coverage of the alternative branch added for Important-1: the
  // "neither plainChild nor htmlChild found" fallthrough.
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "image/png", body: { attachmentId: "att-1" } },
        { mimeType: "image/jpeg", body: { attachmentId: "att-2" } },
      ],
    }),
  ).toBe("");
});

test("a whitespace-only text/plain alternative does not suppress a real sibling text/html", () => {
  // CodeRabbit finding A: `leafText` used to record ANY part whose
  // `body.data` decoded to a non-empty string, including one that decodes
  // to whitespace only. Inside `multipart/alternative` that blank part still
  // wins the type-based pick (plain over html) because `plain.length > 0`,
  // discarding the sibling text/html representation — even though the blank
  // plain part carries nothing usable.
  expect(
    gmailMessageBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("   \n\t  ") } },
        { mimeType: "text/html", body: { data: b64url("<p>real content</p>") } },
      ],
    }),
  ).toBe("real content");
});

test("a whitespace-only text/html leaf is not recorded either", () => {
  expect(gmailMessageBodyText({ mimeType: "text/html", body: { data: b64url("  \n  ") } })).toBe(
    "",
  );
});

test("bounded: content nested deeper than MAX_DEPTH is dropped, not just non-throwing", () => {
  // "does not throw" and "is bounded" are different claims — a 200-level
  // linear chain sits well inside JS's default call-stack limit regardless
  // of the depth guard, so a throw-only assertion would pass identically
  // with the guard deleted. Assert on the VALUE instead: a shallow sibling
  // survives, but text buried under a chain far deeper than the bound must
  // never come back.
  let deepChain: Record<string, unknown> = {
    mimeType: "text/plain",
    body: { data: b64url("buried too deep") },
  };
  for (let i = 0; i < 30; i++) {
    deepChain = { mimeType: "multipart/mixed", parts: [deepChain] };
  }
  const node = {
    mimeType: "multipart/mixed",
    parts: [{ mimeType: "text/plain", body: { data: b64url("shallow text") } }, deepChain],
  };
  const result = gmailMessageBodyText(node as never);
  expect(result).toBe("shallow text");
  expect(result).not.toContain("buried too deep");
});

test("bounded: a wide fanout crossing MAX_PARTS stops the walk", () => {
  // No fixture elsewhere approaches 500 visited parts, so a regression that
  // disables the MAX_PARTS guard is otherwise undetectable. Build 510 direct
  // siblings — comfortably past the 500 cap with margin — and assert that a
  // late sibling's text never makes it into the result while an early
  // sibling's does.
  const parts = Array.from({ length: 510 }, (_, i) => ({
    mimeType: "text/plain",
    body: { data: b64url(`part-${i}`) },
  }));
  const node = { mimeType: "multipart/mixed", parts };
  const result = gmailMessageBodyText(node as never);
  expect(result).toContain("part-0");
  expect(result).not.toContain("part-509");
});

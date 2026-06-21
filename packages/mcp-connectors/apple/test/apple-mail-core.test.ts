import { describe, expect, it } from "bun:test";
import { capPreview, type DraftAppender } from "../src/apple-mail-core.ts";

describe("apple-mail-core", () => {
  it("re-exports capPreview (caps at 2000)", () => {
    expect(capPreview("a".repeat(5000)).length).toBe(2000);
  });
  it("DraftAppender shape is implementable", async () => {
    const fake: DraftAppender = {
      appendDraft: async () => ({ uid: 7, mailbox: "Drafts" }),
    };
    expect(await fake.appendDraft({ to: "x@y.z", subject: "s", body: "b" })).toEqual({
      uid: 7,
      mailbox: "Drafts",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { buildConfluenceKbPageBody } from "../src/kb-append.ts";

describe("buildConfluenceKbPageBody", () => {
  test("creates a page under the parent in the space with storage HTML body", () => {
    const body = buildConfluenceKbPageBody({
      spaceKey: "ENG",
      parentPageId: "9999",
      title: "Deploying the gateway",
      bodyMarkdown: "Run the deploy.\n\n- step one",
      citations: [{ itemId: "slack:C1:1", channelId: "C1", url: "https://s/1" }],
    });
    expect(body["type"]).toBe("page");
    expect(body["title"]).toBe("Deploying the gateway");
    expect(body["space"]).toEqual({ key: "ENG" });
    expect(body["ancestors"]).toEqual([{ id: "9999" }]);
    const storage = (body["body"] as { storage: { value: string; representation: string } })
      .storage;
    expect(storage.representation).toBe("storage");
    expect(storage.value).toContain("<p>Run the deploy.</p>");
    expect(storage.value).toContain("<ul><li>step one</li></ul>");
    expect(storage.value).toContain(`<a href="https://s/1">`);
  });
});

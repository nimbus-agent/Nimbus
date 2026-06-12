import { describe, expect, test } from "bun:test";
import { buildNotionKbPageBody } from "../src/kb-append.ts";

describe("buildNotionKbPageBody", () => {
  test("targets the database, sets the title property, converts the body + citations", () => {
    const body = buildNotionKbPageBody({
      databaseId: "db_123",
      title: "Deploying the gateway",
      bodyMarkdown: "Run the deploy.\n\n- step one",
      citations: [{ itemId: "slack:C1:1", channelId: "C1", url: "https://s/1" }],
    });
    expect(body["parent"]).toEqual({ database_id: "db_123" });
    expect(JSON.stringify(body["properties"])).toContain("Deploying the gateway");
    // default title property name is "Name"
    expect(Object.keys(body["properties"] as object)).toEqual(["Name"]);
    const children = body["children"] as Record<string, unknown>[];
    expect(children.some((c) => c["type"] === "bulleted_list_item")).toBe(true);
    expect(JSON.stringify(children)).toContain("https://s/1");
  });

  test("honors a custom title property name", () => {
    const body = buildNotionKbPageBody({
      databaseId: "db",
      title: "T",
      bodyMarkdown: "x",
      citations: [],
      titlePropertyName: "Question",
    });
    expect(Object.keys(body["properties"] as object)).toEqual(["Question"]);
  });
});

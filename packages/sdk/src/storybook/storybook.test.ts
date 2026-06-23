import { describe, expect, it } from "bun:test";
import { parseStorybookIndex } from "./index.ts";

describe("parseStorybookIndex", () => {
  it("returns [] for null input", () => {
    expect(parseStorybookIndex(null)).toEqual([]);
  });

  it("returns [] for a non-object input", () => {
    expect(parseStorybookIndex("string")).toEqual([]);
    expect(parseStorybookIndex(42)).toEqual([]);
    expect(parseStorybookIndex([])).toEqual([]);
  });

  it("returns [] for an object with no entries or stories key", () => {
    expect(parseStorybookIndex({ unknownKey: {} })).toEqual([]);
  });

  it("parses v7 entries container", () => {
    const input = {
      entries: {
        "button--primary": {
          id: "button--primary",
          title: "Components/Button",
          name: "Primary",
          importPath: "./src/Button.stories.tsx",
          tags: ["autodocs"],
          type: "story",
        },
      },
    };
    const result = parseStorybookIndex(input);
    expect(result).toHaveLength(1);
    const story = result[0];
    expect(story).toBeDefined();
    expect(story?.id).toBe("button--primary");
    expect(story?.title).toBe("Components/Button");
    expect(story?.name).toBe("Primary");
    expect(story?.importPath).toBe("./src/Button.stories.tsx");
    expect(story?.tags).toEqual(["autodocs"]);
    expect(story?.entryType).toBe("story");
  });

  it("parses legacy v6 stories container", () => {
    const input = {
      stories: {
        "button--primary": {
          id: "button--primary",
          kind: "Components/Button",
          story: "Primary",
        },
      },
    };
    const result = parseStorybookIndex(input);
    expect(result).toHaveLength(1);
    const story = result[0];
    expect(story).toBeDefined();
    // v6 uses `kind` → title, `story` → name
    expect(story?.title).toBe("Components/Button");
    expect(story?.name).toBe("Primary");
  });

  it("skips entries missing an id", () => {
    const input = {
      entries: {
        "no-id-entry": { title: "Something", name: "Foo" },
        "has-id": { id: "has-id", title: "Real" },
      },
    };
    const result = parseStorybookIndex(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("has-id");
  });

  it("handles entries with empty-string id as missing (returns null from entryToStory)", () => {
    const input = {
      entries: {
        "empty-id": { id: "", title: "Something" },
        "real-id": { id: "real-id", title: "Real" },
      },
    };
    const result = parseStorybookIndex(input);
    // empty string → str() returns null → entryToStory returns null → skipped
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("real-id");
  });

  it("filters non-string tags and absent tags", () => {
    const input = {
      entries: {
        "story-a": { id: "story-a", tags: ["valid", 42, null, "also-valid"] },
        "story-b": { id: "story-b" }, // no tags field
      },
    };
    const result = parseStorybookIndex(input);
    const storyA = result.find((s) => s.id === "story-a");
    const storyB = result.find((s) => s.id === "story-b");
    expect(storyA?.tags).toEqual(["valid", "also-valid"]);
    expect(storyB?.tags).toEqual([]);
  });

  it("returns null for optional fields when absent", () => {
    const input = {
      entries: {
        minimal: { id: "minimal" },
      },
    };
    const result = parseStorybookIndex(input);
    expect(result).toHaveLength(1);
    const story = result[0];
    expect(story?.title).toBeNull();
    expect(story?.name).toBeNull();
    expect(story?.importPath).toBeNull();
    expect(story?.entryType).toBeNull();
  });

  it("prefers entries over stories when both keys present", () => {
    // asRecord(root["entries"]) is tried first; stories is ignored when entries is valid
    const input = {
      entries: { "entry-id": { id: "entry-id", title: "From entries" } },
      stories: { "story-id": { id: "story-id", title: "From stories" } },
    };
    const result = parseStorybookIndex(input);
    // Should only parse "entries" (the ?? short-circuits)
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("entry-id");
  });

  it("skips non-object values inside the container", () => {
    const input = {
      entries: {
        "null-entry": null,
        "string-entry": "not an object",
        "valid-entry": { id: "valid-entry", title: "Valid" },
      },
    };
    const result = parseStorybookIndex(input);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("valid-entry");
  });
});

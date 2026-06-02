import { describe, expect, test } from "bun:test";

import {
  mapStorybookStoryToItem,
  parseStorybookIndex,
  type StorybookStoryInput,
} from "../../../src/connectors/storybook-story-mapping.ts";

const SYNCED_AT = 1_750_000_000_000;

describe("parseStorybookIndex", () => {
  test("parses the v7+ entries shape", () => {
    const parsed = parseStorybookIndex({
      v: 5,
      entries: {
        "components-button--primary": {
          id: "components-button--primary",
          title: "Components/Button",
          name: "Primary",
          importPath: "./src/Button.stories.tsx",
          tags: ["autodocs", "story"],
          type: "story",
        },
      },
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      id: "components-button--primary",
      title: "Components/Button",
      name: "Primary",
      importPath: "./src/Button.stories.tsx",
      tags: ["autodocs", "story"],
      entryType: "story",
    });
  });

  test("parses the legacy v6 stories shape (kind/story aliases)", () => {
    const parsed = parseStorybookIndex({
      v: 3,
      stories: {
        "button--default": {
          id: "button--default",
          kind: "Button",
          story: "Default",
          importPath: "./Button.stories.js",
        },
      },
    });
    expect(parsed[0]?.title).toBe("Button");
    expect(parsed[0]?.name).toBe("Default");
  });

  test("skips entries without an id and returns [] for an unknown shape", () => {
    expect(parseStorybookIndex({ entries: { x: { title: "no id" } } })).toEqual([]);
    expect(parseStorybookIndex({ nonsense: true })).toEqual([]);
    expect(parseStorybookIndex(null)).toEqual([]);
  });
});

describe("mapStorybookStoryToItem", () => {
  function input(over: Partial<StorybookStoryInput> = {}): StorybookStoryInput {
    return {
      id: "components-button--primary",
      title: "Components/Button",
      name: "Primary",
      importPath: "./src/Button.stories.tsx",
      tags: ["autodocs"],
      entryType: "story",
      ...over,
    };
  }

  test("maps to a storybook:story item with title 'Component / Story'", () => {
    const row = mapStorybookStoryToItem(input(), { syncedAt: SYNCED_AT, modifiedAtMs: 123 });
    expect(row).not.toBeNull();
    if (row === null) {
      return;
    }
    expect(row.service).toBe("storybook");
    expect(row.type).toBe("story");
    expect(row.externalId).toBe("components-button--primary");
    expect(row.title).toBe("Components/Button / Primary");
    expect(row.bodyPreview).toContain("Button.stories.tsx");
    expect(row.modifiedAt).toBe(123);
    expect(row.metadata.componentTitle).toBe("Components/Button");
    expect(row.metadata.tags).toEqual(["autodocs"]);
  });

  test("falls back to id for the title when title + name are absent", () => {
    const row = mapStorybookStoryToItem(input({ title: null, name: null }), {
      syncedAt: SYNCED_AT,
      modifiedAtMs: null,
    });
    expect(row?.title).toBe("components-button--primary");
    expect(row?.modifiedAt).toBe(SYNCED_AT);
  });

  test("returns null for an empty id", () => {
    expect(
      mapStorybookStoryToItem(input({ id: "  " }), { syncedAt: SYNCED_AT, modifiedAtMs: null }),
    ).toBeNull();
  });
});

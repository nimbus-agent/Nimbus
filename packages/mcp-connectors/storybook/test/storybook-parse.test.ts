import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filterStories,
  loadStories,
  parseStorybookIndex,
  type StorybookStory,
  storybookDir,
} from "../src/storybook-parse.ts";

describe("parseStorybookIndex", () => {
  test("parses v7 entries and legacy v6 stories", () => {
    expect(parseStorybookIndex({ entries: { a: { id: "a", title: "T", name: "N" } } })).toEqual([
      { id: "a", title: "T", name: "N", importPath: null, tags: [], entryType: null },
    ]);
    expect(
      parseStorybookIndex({ stories: { b: { id: "b", kind: "K", story: "S" } } })[0]?.title,
    ).toBe("K");
  });

  test("returns [] for an unknown shape", () => {
    expect(parseStorybookIndex({ x: 1 })).toEqual([]);
    expect(parseStorybookIndex(null)).toEqual([]);
  });
});

describe("storybookDir", () => {
  test("throws when STORYBOOK_DIR is unset", () => {
    const prev = process.env["STORYBOOK_DIR"];
    delete process.env["STORYBOOK_DIR"];
    expect(() => storybookDir()).toThrow();
    if (prev !== undefined) {
      process.env["STORYBOOK_DIR"] = prev;
    }
  });
});

describe("filterStories", () => {
  const stories: StorybookStory[] = [
    {
      id: "button--primary",
      title: "Components/Button",
      name: "Primary",
      importPath: null,
      tags: ["a11y"],
      entryType: "story",
    },
    {
      id: "card--default",
      title: "Components/Card",
      name: "Default",
      importPath: null,
      tags: [],
      entryType: "story",
    },
  ];
  test("matches id / title / name / tags; empty query returns all", () => {
    expect(filterStories(stories, "button")).toHaveLength(1);
    expect(filterStories(stories, "card")).toHaveLength(1);
    expect(filterStories(stories, "primary")).toHaveLength(1);
    expect(filterStories(stories, "a11y")).toHaveLength(1);
    expect(filterStories(stories, "  ")).toHaveLength(2);
    expect(filterStories(stories, "nope")).toHaveLength(0);
  });
});

describe("loadStories (real fs)", () => {
  let dir: string;
  let prev: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nimbus-storybook-parse-"));
    prev = process.env["STORYBOOK_DIR"];
    process.env["STORYBOOK_DIR"] = dir;
  });
  afterEach(async () => {
    if (prev === undefined) {
      delete process.env["STORYBOOK_DIR"];
    } else {
      process.env["STORYBOOK_DIR"] = prev;
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("reads index.json under the configured dir", async () => {
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify({
        v: 5,
        entries: { "b--p": { id: "b--p", title: "Button", name: "Primary" } },
      }),
      "utf8",
    );
    const stories = await loadStories();
    expect(stories).toHaveLength(1);
    expect(stories[0]?.title).toBe("Button");
  });

  test("returns [] when no manifest exists", async () => {
    expect(await loadStories()).toEqual([]);
  });
});

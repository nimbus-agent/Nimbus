import { expect, test } from "bun:test";
import { parseNote, resolveWikilinks } from "./obsidian-parsing.ts";

test("parseNote extracts YAML frontmatter, body, H1 title, tags, aliases, wikilinks", () => {
  const md = `---
tags: [a, b]
aliases:
  - first-alias
  - second-alias
custom: foo
---
# Real Title
Some body text linking to [[Other Note]] and [[Page#Section|alias here]] and [[Unresolved]].
`;
  const out = parseNote("notes/x.md", md);
  expect(out.title).toBe("Real Title");
  expect(out.body).toContain("Some body text");
  expect(out.body.startsWith("---")).toBe(false);
  expect(out.frontmatter["custom"]).toBe("foo");
  expect(out.tags).toEqual(["a", "b"]);
  expect(out.aliases).toEqual(["first-alias", "second-alias"]);
  expect(out.wikilinks).toEqual(["Other Note", "Page", "Unresolved"]);
});

test("parseNote falls back to filename (without .md) when no H1 is present", () => {
  const out = parseNote("notes/MyNote.md", "no heading here\n");
  expect(out.title).toBe("MyNote");
});

test("parseNote tolerates missing frontmatter and empty body", () => {
  const out = parseNote("notes/Empty.md", "");
  expect(out.title).toBe("Empty");
  expect(out.body).toBe("");
  expect(out.frontmatter).toEqual({});
  expect(out.tags).toEqual([]);
  expect(out.aliases).toEqual([]);
  expect(out.wikilinks).toEqual([]);
});

test("parseNote tolerates malformed YAML — falls back to empty frontmatter and full body", () => {
  const md = `---
this is: [not matching bracket
---
body`;
  const out = parseNote("notes/x.md", md);
  expect(out.frontmatter).toEqual({});
  expect(out.tags).toEqual([]);
  expect(out.body).toBe("body");
});

test("parseNote detects daily-note date when filename matches YYYY-MM-DD.md", () => {
  expect(parseNote("Daily/2026-05-10.md", "").dailyNoteDate).toBe("2026-05-10");
  expect(parseNote("notes/MyNote.md", "").dailyNoteDate).toBe(undefined);
  expect(parseNote("Daily/2026-13-99.md", "").dailyNoteDate).toBe(undefined);
});

test("resolveWikilinks resolves by exact filename (case-insensitive), then by title; preserves unresolved as raw strings", () => {
  const idx = new Map<string, { id: string; title: string }>([
    ["other note.md", { id: "obsidian:abc#Other Note.md", title: "Other Note" }],
    ["page.md", { id: "obsidian:abc#Page.md", title: "Page" }],
    ["readme.md", { id: "obsidian:abc#README.md", title: "Hidden Title" }],
  ]);
  const titleIdx = new Map<string, string>([["hidden title", "obsidian:abc#README.md"]]);
  const out = resolveWikilinks(["Other Note", "Page", "Hidden Title", "Missing"], idx, titleIdx);
  expect(out.resolved).toEqual([
    "obsidian:abc#Other Note.md",
    "obsidian:abc#Page.md",
    "obsidian:abc#README.md",
  ]);
  expect(out.unresolved).toEqual(["Missing"]);
});

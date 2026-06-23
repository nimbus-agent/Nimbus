import { describe, expect, test } from "bun:test";
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
  expect(parseNote("notes/MyNote.md", "").dailyNoteDate).toBeUndefined();
  expect(parseNote("Daily/2026-13-99.md", "").dailyNoteDate).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("extractFrontmatterAndBody — YAML non-object values fall back to empty frontmatter", () => {
  test("YAML parses to null → empty frontmatter", () => {
    // A YAML document consisting only of "null" is valid and returns null
    const md = `---\nnull\n---\nbody text`;
    const out = parseNote("notes/x.md", md);
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("body text");
  });

  test("YAML parses to a string scalar → empty frontmatter", () => {
    // A bare scalar string is valid YAML but not an object
    const md = `---\njust a string\n---\nbody here`;
    const out = parseNote("notes/x.md", md);
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("body here");
  });

  test("YAML parses to an array → empty frontmatter", () => {
    const md = `---\n- item1\n- item2\n---\nbody after array`;
    const out = parseNote("notes/x.md", md);
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("body after array");
  });

  test("YAML parses to a number → empty frontmatter", () => {
    const md = `---\n42\n---\nnumeric body`;
    const out = parseNote("notes/x.md", md);
    expect(out.frontmatter).toEqual({});
    expect(out.body).toBe("numeric body");
  });
});

describe("extractTitle — edge cases", () => {
  test("H1 where captured group trims to empty string falls back to filename", () => {
    // "#  " → \s+ eats the first space, (.+) captures the second space → trim() = "" → filename fallback
    const out = parseNote("notes/TrimmedEmpty.md", "#  ");
    expect(out.title).toBe("TrimmedEmpty");
  });

  test("relPath with Windows-style backslashes is normalised to forward slashes", () => {
    const out = parseNote("notes\\sub\\MyNote.md", "# Heading\nbody");
    expect(out.relPath).toBe("notes/sub/MyNote.md");
    // Title still extracted from H1
    expect(out.title).toBe("Heading");
  });

  test("no H1 in file that has frontmatter — falls back to filename", () => {
    const md = `---\ntags: [x]\n---\nsome paragraph without heading`;
    const out = parseNote("notes/JustParagraph.md", md);
    expect(out.title).toBe("JustParagraph");
  });

  test("filename without .md extension — basename used as-is", () => {
    // Exercises the replace(/\.md$/i, "") branch when extension is absent
    const out = parseNote("notes/NoteNoExt", "just body");
    expect(out.title).toBe("NoteNoExt");
  });
});

describe("extractTags — string variant and empty/whitespace guards", () => {
  test("tags as a single string → wrapped in array", () => {
    const md = `---\ntags: single-tag\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.tags).toEqual(["single-tag"]);
  });

  test("tags as empty string → empty array", () => {
    const md = `---\ntags: ""\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.tags).toEqual([]);
  });

  test("tags as whitespace-only string → empty array", () => {
    const md = `---\ntags: "   "\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.tags).toEqual([]);
  });

  test("tags array with mixed types filters to only strings", () => {
    // js-yaml preserves types, so we get numbers alongside strings
    const md = `---\ntags:\n  - good-tag\n  - 42\n  - another\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.tags).toEqual(["good-tag", "another"]);
  });

  test("tags absent → empty array", () => {
    const md = `---\ncustom: value\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.tags).toEqual([]);
  });
});

describe("extractAliases — string variant and empty/whitespace guards", () => {
  test("aliases as a single string → wrapped in array", () => {
    const md = `---\naliases: my-alias\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.aliases).toEqual(["my-alias"]);
  });

  test("aliases as empty string → empty array", () => {
    const md = `---\naliases: ""\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.aliases).toEqual([]);
  });

  test("aliases as whitespace-only string → empty array", () => {
    const md = `---\naliases: "  "\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.aliases).toEqual([]);
  });

  test("aliases array with mixed types filters to only strings", () => {
    const md = `---\naliases:\n  - real-alias\n  - 99\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.aliases).toEqual(["real-alias"]);
  });

  test("aliases absent → empty array", () => {
    const md = `---\ncustom: value\n---\nbody`;
    const out = parseNote("notes/x.md", md);
    expect(out.aliases).toEqual([]);
  });
});

describe("extractWikilinks — edge cases", () => {
  test("wikilink with only a section anchor (no filename) is skipped", () => {
    // [[#Section]] → noAlias="#Section", split("#")[0]="" → target="" → skipped
    const out = parseNote("notes/x.md", "See [[#Introduction]] for details.");
    expect(out.wikilinks).toEqual([]);
  });

  test("wikilink target with leading/trailing spaces is trimmed", () => {
    const out = parseNote("notes/x.md", "Link [[  SpacedNote  ]] here.");
    expect(out.wikilinks).toEqual(["SpacedNote"]);
  });

  test("multiple wikilinks including mixed alias/section variants", () => {
    const body = "[[NoteA]] and [[NoteB|display]] and [[NoteC#heading]] and [[NoteD#h|label]]";
    const out = parseNote("notes/x.md", body);
    expect(out.wikilinks).toEqual(["NoteA", "NoteB", "NoteC", "NoteD"]);
  });

  test("no wikilinks → empty array", () => {
    const out = parseNote("notes/x.md", "just plain text without any links");
    expect(out.wikilinks).toEqual([]);
  });
});

describe("extractDailyNoteDate — boundary values", () => {
  test("month=0 (< 1) → undefined", () => {
    // DAILY_NOTE_RE requires two digits but 00 is a real match for the regex
    expect(parseNote("Daily/2026-00-15.md", "").dailyNoteDate).toBeUndefined();
  });

  test("day=0 (< 1) → undefined", () => {
    expect(parseNote("Daily/2026-06-00.md", "").dailyNoteDate).toBeUndefined();
  });

  test("month=12 and day=31 (boundary) → valid", () => {
    expect(parseNote("Daily/2026-12-31.md", "").dailyNoteDate).toBe("2026-12-31");
  });

  test("filename in a deeply nested path is matched on basename only", () => {
    expect(parseNote("vault/daily/2026-01-01.md", "").dailyNoteDate).toBe("2026-01-01");
  });
});

describe("resolveWikilinks — additional branches", () => {
  test("target that matches filename WITHOUT .md suffix via direct key", () => {
    // byFilenameLower.get(lc) hits directly (key has no .md)
    const idx = new Map<string, { id: string; title: string }>([
      ["readme", { id: "obsidian:abc#README", title: "README" }],
    ]);
    const out = resolveWikilinks(["README"], idx, new Map());
    expect(out.resolved).toEqual(["obsidian:abc#README"]);
    expect(out.unresolved).toEqual([]);
  });

  test("empty targets list → both arrays empty", () => {
    const out = resolveWikilinks([], new Map(), new Map());
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });

  test("all targets unresolved", () => {
    const out = resolveWikilinks(["Ghost", "Phantom"], new Map(), new Map());
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(["Ghost", "Phantom"]);
  });

  test("case-insensitive match via .md suffix path", () => {
    // Target is "MyNote" (no .md); index key is "mynote.md"
    // byFilenameLower.get("mynote") → undefined, then .get("mynote.md") → hit
    const idx = new Map<string, { id: string; title: string }>([
      ["mynote.md", { id: "obsidian:xyz#MyNote.md", title: "My Note" }],
    ]);
    const out = resolveWikilinks(["MyNote"], idx, new Map());
    expect(out.resolved).toEqual(["obsidian:xyz#MyNote.md"]);
    expect(out.unresolved).toEqual([]);
  });
});

describe("parseNote — frontmatter with CRLF line endings", () => {
  test("frontmatter delimited by CRLF is correctly parsed", () => {
    const md = "---\r\ntags: [crlf-tag]\r\n---\r\nCRLF body";
    const out = parseNote("notes/crlf.md", md);
    expect(out.tags).toEqual(["crlf-tag"]);
    expect(out.body).toBe("CRLF body");
  });
});

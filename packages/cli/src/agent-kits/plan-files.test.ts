import { describe, expect, test } from "bun:test";

import {
  childArray,
  childObject,
  editJsonFile,
  findBlock,
  hasBlock,
  jsonAt,
  KitRefusal,
  normaliseNewlines,
  parseJsonFile,
  renderBlock,
  sameText,
  sha256Hex,
  upsertBlock,
  withoutBlock,
} from "./plan-files.ts";

const BODY = "line one\nline two";

describe("owned blocks", () => {
  test("a block is a begin marker with the body's hash, the body, and an end marker", () => {
    expect(renderBlock("codex", 1, BODY, "hash")).toBe(
      `# >>> nimbus agent kit codex v1 sha256:${sha256Hex(BODY)} >>>\n${BODY}\n# <<< nimbus agent kit codex <<<`,
    );
    expect(renderBlock("vscode", 3, BODY, "html")).toBe(
      `<!-- >>> nimbus agent kit vscode v3 sha256:${sha256Hex(BODY)} >>> -->\n${BODY}\n<!-- <<< nimbus agent kit vscode <<< -->`,
    );
  });

  test.each(["hash", "html"] as const)("a new file is the block and one newline (%s)", (style) => {
    const out = upsertBlock(null, "codex", 1, BODY, style);
    expect(out).toBe(`${renderBlock("codex", 1, BODY, style)}\n`);
    expect(upsertBlock("", "codex", 1, BODY, style)).toBe(out);
    expect(upsertBlock("  \n\n", "codex", 1, BODY, style)).toBe(out);
  });

  test.each(["hash", "html"] as const)(
    "the block is appended after a blank line and everything before it is untouched (%s)",
    (style) => {
      for (const existing of ["mine = 1\n", "mine = 1", "mine = 1\n\n\n"]) {
        const out = upsertBlock(existing, "codex", 1, BODY, style);
        expect(out).toBe(`mine = 1\n\n${renderBlock("codex", 1, BODY, style)}\n`);
      }
    },
  );

  test("installing again changes nothing, and a new body replaces only the block", () => {
    const first = upsertBlock("before\n", "codex", 1, BODY, "hash");
    const withTail = `${first}after\n`;
    expect(upsertBlock(withTail, "codex", 1, BODY, "hash")).toBe(withTail);
    const second = upsertBlock(withTail, "codex", 2, "new body", "hash");
    expect(second).toBe(`before\n\n${renderBlock("codex", 2, "new body", "hash")}\nafter\n`);
  });

  test("two kits keep separate blocks in one file", () => {
    const a = upsertBlock("top\n", "codex", 1, "A", "html");
    const both = upsertBlock(a, "vscode", 1, "B", "html");
    expect(findBlock(both, "codex", "html")?.body).toBe("A");
    expect(findBlock(both, "vscode", "html")?.body).toBe("B");
    const changed = upsertBlock(both, "codex", 1, "A2", "html");
    expect(findBlock(changed, "codex", "html")?.body).toBe("A2");
    expect(findBlock(changed, "vscode", "html")?.body).toBe("B");
    expect(withoutBlock(changed, "codex", "html")).toContain("nimbus agent kit vscode");
    expect(withoutBlock(changed, "codex", "html")).not.toContain("nimbus agent kit codex");
  });

  test("a CRLF file stays CRLF, and the same block read with either line ending is unchanged", () => {
    const crlf = upsertBlock("mine = 1\r\n", "codex", 1, BODY, "hash");
    expect(crlf).toContain("\r\n");
    expect(crlf.replaceAll("\r\n", "")).not.toContain("\n");
    // The hash is over LF text, so converting the file does not make the block look edited.
    const asLf = normaliseNewlines(crlf);
    expect(findBlock(asLf, "codex", "hash")?.hashMatches).toBe(true);
    expect(sameText(upsertBlock(asLf, "codex", 1, BODY, "hash"), crlf)).toBe(true);
    expect(sameText(upsertBlock(crlf, "codex", 1, BODY, "hash"), crlf)).toBe(true);
  });

  test("a body someone edited no longer matches its hash", () => {
    const text = upsertBlock(null, "codex", 4, BODY, "hash").replace("line two", "line 2");
    const found = findBlock(text, "codex", "hash");
    expect(found).toMatchObject({ body: "line one\nline 2", version: 4, hashMatches: false });
  });

  test("an empty body round-trips", () => {
    const text = upsertBlock(null, "codex", 1, "", "hash");
    expect(findBlock(text, "codex", "hash")).toMatchObject({ body: "", hashMatches: true });
  });

  test("a marker inside other text is not a block: only a whole line counts", () => {
    const text = `note: "# >>> nimbus agent kit codex v1 sha256:${"a".repeat(64)} >>>" is how it starts\n`;
    expect(findBlock(text, "codex", "hash")).toBeUndefined();
    expect(
      findBlock("# >>> nimbus agent kit codex v1 sha256:short >>>\n", "codex", "hash"),
    ).toBeUndefined();
    // Another kit's block is not this kit's.
    expect(findBlock(upsertBlock(null, "codex2", 1, "x", "hash"), "codex", "hash")).toBeUndefined();
  });

  test("an end marker with text after it on the same line is not an end: the block is refused, the tail never orphaned", () => {
    const good = upsertBlock("top\n", "codex", 1, BODY, "hash");
    const tailed = good.replace(
      "# <<< nimbus agent kit codex <<<",
      "# <<< nimbus agent kit codex <<< my note",
    );
    expect(() => upsertBlock(tailed, "codex", 1, "new", "hash")).toThrow(/with no end/);
    // A real end marker further down still closes it, and the tailed line is part of the body.
    const closed = `${tailed}# <<< nimbus agent kit codex <<<\nafter\n`;
    const found = findBlock(closed, "codex", "hash");
    expect(found?.body).toContain("my note");
    expect(upsertBlock(closed, "codex", 1, "new", "hash")).toBe(
      `top\n\n${renderBlock("codex", 1, "new", "hash")}\nafter\n`,
    );
    // The end marker as the very last bytes of the file (no trailing newline) is an end.
    expect(findBlock(good.trimEnd(), "codex", "hash")?.body).toBe(BODY);
  });

  test("a block with no end, and two blocks for one kit, are refused and never edited", () => {
    const open = renderBlock("codex", 1, BODY, "hash").split("\n").slice(0, 2).join("\n");
    expect(() => upsertBlock(`${open}\n`, "codex", 1, BODY, "hash")).toThrow(KitRefusal);
    const one = upsertBlock(null, "codex", 1, BODY, "hash");
    expect(() => upsertBlock(one + one, "codex", 1, BODY, "hash")).toThrow(/two Nimbus blocks/);
    // Something is there, so it counts as present.
    expect(hasBlock(`${open}\n`, "codex", "hash")).toBe(true);
    expect(hasBlock(one, "codex", "hash")).toBe(true);
    expect(hasBlock("nothing here\n", "codex", "hash")).toBe(false);
  });
});

describe("strict JSON files", () => {
  test("an absent or empty file is an empty object", () => {
    expect(parseJsonFile(null, "f")).toEqual({});
    expect(parseJsonFile("  \n", "f")).toEqual({});
  });

  test("a comment, a trailing comma and a non-object are refused with the file named", () => {
    for (const bad of ['{ // note\n "a": 1 }', '{ "a": 1, }', "[1]", '"text"', "null", "{"]) {
      expect(() => parseJsonFile(bad, "/x/settings.json"), bad).toThrow(KitRefusal);
      expect(() => editJsonFile(bad, "/x/settings.json", () => {}), bad).toThrow(
        /\/x\/settings\.json/,
      );
    }
  });

  test("an edit that changes nothing returns the original text byte for byte", () => {
    const odd = '{"a":1,\n\n      "b": [ 1,2 ]}\r\n';
    expect(editJsonFile(odd, "f", () => {})).toBe(odd);
    expect(
      editJsonFile(odd, "f", (root) => {
        root["a"] = 1;
      }),
    ).toBe(odd);
  });

  test("a change keeps every other key in order, the file's indent and its line ending", () => {
    const before = '{\n    "z": 1,\n    "a": { "keep": [1, 2] }\n}\n';
    const after = editJsonFile(before, "f", (root) => {
      childObject(root, "mcpServers", "f")["nimbus"] = { command: "nimbus" };
    });
    expect(after).toBe(
      '{\n    "z": 1,\n    "a": {\n        "keep": [\n            1,\n            2\n        ]\n    },\n    "mcpServers": {\n        "nimbus": {\n            "command": "nimbus"\n        }\n    }\n}\n',
    );
    const crlf = editJsonFile('{\r\n  "z": 1\r\n}\r\n', "f", (root) => {
      root["y"] = 2;
    });
    expect(crlf).toBe('{\r\n  "z": 1,\r\n  "y": 2\r\n}\r\n');
    expect(
      editJsonFile(null, "f", (root) => {
        root["y"] = 2;
      }),
    ).toBe('{\n  "y": 2\n}\n');
  });

  test("a key that holds something else is refused, never replaced", () => {
    expect(() => childObject({ hooks: [] }, "hooks", "f")).toThrow(/"hooks" is not an object/);
    expect(() => childObject({ hooks: "x" }, "hooks", "f")).toThrow(KitRefusal);
    expect(() => childArray({ deny: {} }, "deny", "f")).toThrow(/"deny" is not a list/);
    const root: Record<string, unknown> = {};
    expect(childArray(root, "deny", "f")).toEqual([]);
    expect(root).toEqual({ deny: [] });
  });

  test("jsonAt reads a path and is undefined for anything missing or unparseable", () => {
    const text = '{"a":{"b":{"c":1}}}';
    expect(jsonAt(text, ["a", "b", "c"])).toBe(1);
    expect(jsonAt(text, ["a", "x"])).toBeUndefined();
    expect(jsonAt(text, ["a", "b", "c", "d"])).toBeUndefined();
    expect(jsonAt("{ not json", ["a"])).toBeUndefined();
  });
});

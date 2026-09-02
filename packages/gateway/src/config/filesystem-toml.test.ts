import { expect, test } from "bun:test";

import { parseNimbusTomlFilesystemRoots } from "./filesystem-toml.ts";

test("parses [[filesystem.roots]] blocks", () => {
  const src = `
[embedding]
enabled = false

[[filesystem.roots]]
path = "/tmp/proj"
git_aware = true
code_index = true
dependency_graph = true
exclude = "node_modules,.git"

[[filesystem.roots]]
path = "~/other"
git_aware = false
`;
  const roots = parseNimbusTomlFilesystemRoots(src);
  expect(roots).toHaveLength(2);
  expect(roots[0]?.path).toContain("proj");
  expect(roots[0]?.gitAware).toBe(true);
  expect(roots[0]?.codeIndex).toBe(true);
  expect(roots[0]?.exclude).toContain("node_modules");
  expect(roots[1]?.gitAware).toBe(false);
});

test("a root path containing # is not truncated", () => {
  const raw = ["[[filesystem.roots]]", 'path = "/home/me/notes/#inbox"'].join("\n");
  const roots = parseNimbusTomlFilesystemRoots(raw);
  expect(roots).toHaveLength(1);
  // toContain, not toBe: expandPath() runs the result through node's
  // path.resolve(), which on Windows prepends a drive letter and flips
  // separators for an already-absolute POSIX-style input (matching the
  // toContain("proj") convention used above for the same reason). The
  // assertion below still fails pre-fix, since the truncated/mis-parsed
  // value never contains the literal "#inbox" segment.
  expect(roots[0]?.path).toContain("#inbox");
});

test("an escaped quote inside an exclude entry unescapes correctly", () => {
  // Covers the parseString half of the swap (not just stripComment): the
  // `exclude` field stays a literal array of strings with no expandPath()/
  // resolve() in between, so this is a clean surface for the \" unescape.
  const raw = [
    "[[filesystem.roots]]",
    'path = "/tmp/proj"',
    String.raw`exclude = "the \"vendor\" dir,.git"`,
  ].join("\n");
  const roots = parseNimbusTomlFilesystemRoots(raw);
  expect(roots).toHaveLength(1);
  expect(roots[0]?.exclude).toEqual(['the "vendor" dir', ".git"]);
});

test("media_index defaults to false — media indexing is opt-in per root", () => {
  const raw = ["[[filesystem.roots]]", 'path = "/tmp/x"'].join("\n");
  const roots = parseNimbusTomlFilesystemRoots(raw);
  expect(roots).toHaveLength(1);
  expect(roots[0]?.mediaIndex).toBe(false);
});

test("media_index = true is parsed", () => {
  const raw = ["[[filesystem.roots]]", 'path = "/tmp/x"', "media_index = true"].join("\n");
  const roots = parseNimbusTomlFilesystemRoots(raw);
  expect(roots).toHaveLength(1);
  expect(roots[0]?.mediaIndex).toBe(true);
});

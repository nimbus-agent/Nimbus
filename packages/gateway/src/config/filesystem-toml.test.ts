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

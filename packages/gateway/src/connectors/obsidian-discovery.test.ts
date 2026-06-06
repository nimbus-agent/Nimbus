import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverNotesInVault, discoverVaults } from "./obsidian-discovery.ts";

function setupTree(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "obsidian-disc-"));
  mkdirSync(join(root, "Vault1", ".obsidian"), { recursive: true });
  writeFileSync(join(root, "Vault1", "Welcome.md"), "# Welcome");
  mkdirSync(join(root, "Vault1", "subfolder"), { recursive: true });
  writeFileSync(join(root, "Vault1", "subfolder", "Nested.md"), "# Nested");
  mkdirSync(join(root, "Vault1", "Inner", ".obsidian"), { recursive: true });
  writeFileSync(join(root, "Vault1", "Inner", "InnerNote.md"), "# Inner");
  mkdirSync(join(root, "node_modules", "junk", ".obsidian"), { recursive: true });
  writeFileSync(join(root, "node_modules", "junk", "Skip.md"), "# Skip");
  mkdirSync(join(root, "Random"), { recursive: true });
  writeFileSync(join(root, "Random", "NotInVault.md"), "");
  return { root };
}

test("discoverVaults returns absolute paths of every directory containing .obsidian/", () => {
  const { root } = setupTree();
  const found = discoverVaults([root]);
  const rels = found.map((p) => p.replace(root, "").replaceAll("\\", "/"));
  expect(rels.includes("/Vault1")).toBe(true);
  expect(rels.includes("/Vault1/Inner")).toBe(true);
  for (const r of rels) {
    expect(r.includes("node_modules")).toBe(false);
  }
  expect(rels.includes("/Random")).toBe(false);
});

test("discoverNotesInVault returns relative paths of all .md files under the vault root", () => {
  const { root } = setupTree();
  const notes = discoverNotesInVault(join(root, "Vault1")).map((p) => p.replaceAll("\\", "/"));
  expect(notes).toContain("Welcome.md");
  expect(notes).toContain("subfolder/Nested.md");
  expect(notes.some((p) => p.startsWith("Inner/"))).toBe(false);
  expect(notes.every((p) => p.endsWith(".md"))).toBe(true);
});

test("discoverNotesInVault skips .obsidian/ directory contents", () => {
  const { root } = setupTree();
  writeFileSync(join(root, "Vault1", ".obsidian", "ConfigNote.md"), "# nope");
  const notes = discoverNotesInVault(join(root, "Vault1"));
  expect(notes.some((p) => p.includes(".obsidian"))).toBe(false);
});

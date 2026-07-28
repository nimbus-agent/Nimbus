import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFilesystemRoot, hasFilesystemRoot } from "./toml-append.ts";

let dir: string;

beforeEach(() => {
  dir = join(tmpdir(), `nimbus-toml-write-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("creates nimbus.toml when absent and adds the root", () => {
  const res = appendFilesystemRoot(dir, join(dir, "repo-a"));
  expect(res.status).toBe("added");
  const written = readFileSync(res.tomlPath, "utf8");
  expect(written).toContain("[[filesystem.roots]]");
  expect(written).toContain("code_index = true");
  expect(hasFilesystemRoot(written, join(dir, "repo-a"))).toBe(true);
});

test("hasFilesystemRoot ignores a commented-out root", () => {
  // A commented block must not make init think it is already configured.
  const src = ["[[filesystem.roots]]", `# path = "${join(dir, "repo-a")}"`, ""].join("\n");
  expect(hasFilesystemRoot(src, join(dir, "repo-a"))).toBe(false);
});

test("hasFilesystemRoot ignores a path key under a different table", () => {
  // Otherwise init reports "already configured" and silently never adds the root.
  const src = ["[some_other_section]", `path = "${join(dir, "repo-a")}"`, ""].join("\n");
  expect(hasFilesystemRoot(src, join(dir, "repo-a"))).toBe(false);
});

test("a Windows-style path survives the write/read round-trip", () => {
  // The writer emits TOML `\\` escapes; the gateway's parseString un-escapes
  // only `\"`, NOT `\\`. The round-trip holds because expandPath calls
  // resolve(), which normalises the doubled separators — verified, but
  // incidental, so it is pinned here rather than assumed.
  const sep = String.fromCharCode(92);
  const win = ["C:", "gitrep", "Nimbus"].join(sep);
  appendFilesystemRoot(dir, win);
  const written = readFileSync(join(dir, "nimbus.toml"), "utf8");
  expect(hasFilesystemRoot(written, win)).toBe(true);
  expect(appendFilesystemRoot(dir, win).status).toBe("already-present");
});

test("preserves comments, formatting, and unrelated sections verbatim", () => {
  // The whole reason this is append-only: a parse/serialize cycle would lose these.
  const original = ["# my notes", "", "[llm]", "prefer_local = true  # keep me", ""].join("\n");
  writeFileSync(join(dir, "nimbus.toml"), original, "utf8");

  appendFilesystemRoot(dir, join(dir, "repo-a"));

  const after = readFileSync(join(dir, "nimbus.toml"), "utf8");
  expect(after.startsWith(original)).toBe(true);
  expect(after).toContain("# my notes");
  expect(after).toContain("prefer_local = true  # keep me");
});

test("is idempotent — a second call reports already-present and does not duplicate", () => {
  appendFilesystemRoot(dir, join(dir, "repo-a"));
  const second = appendFilesystemRoot(dir, join(dir, "repo-a"));
  expect(second.status).toBe("already-present");
  const written = readFileSync(second.tomlPath, "utf8");
  expect(written.split("[[filesystem.roots]]").length - 1).toBe(1);
});

test("writes a .bak before modifying an existing file", () => {
  writeFileSync(join(dir, "nimbus.toml"), "# original\n", "utf8");
  const res = appendFilesystemRoot(dir, join(dir, "repo-a"));
  expect(res.backupPath).toBe(join(dir, "nimbus.toml.bak"));
  expect(readFileSync(join(dir, "nimbus.toml.bak"), "utf8")).toBe("# original\n");
});

test("no backup is written when the file did not exist", () => {
  const res = appendFilesystemRoot(dir, join(dir, "repo-a"));
  expect(res.backupPath).toBeUndefined();
  expect(existsSync(join(dir, "nimbus.toml.bak"))).toBe(false);
});

test("a second distinct root appends alongside the first", () => {
  appendFilesystemRoot(dir, join(dir, "repo-a"));
  appendFilesystemRoot(dir, join(dir, "repo-b"));
  const written = readFileSync(join(dir, "nimbus.toml"), "utf8");
  expect(written.split("[[filesystem.roots]]").length - 1).toBe(2);
  expect(hasFilesystemRoot(written, join(dir, "repo-a"))).toBe(true);
  expect(hasFilesystemRoot(written, join(dir, "repo-b"))).toBe(true);
});

test("appends a leading newline when the existing file lacks a trailing one", () => {
  writeFileSync(join(dir, "nimbus.toml"), "# no trailing newline", "utf8");
  appendFilesystemRoot(dir, join(dir, "repo-a"));
  const after = readFileSync(join(dir, "nimbus.toml"), "utf8");
  // Without the guard the header would be glued onto the comment line and the
  // whole block would be swallowed as part of that comment.
  expect(after).toContain("# no trailing newline\n");
  expect(hasFilesystemRoot(after, join(dir, "repo-a"))).toBe(true);
});

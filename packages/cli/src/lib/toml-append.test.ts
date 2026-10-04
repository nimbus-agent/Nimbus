import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { appendFilesystemRoot, hasFilesystemRoot } from "./toml-append.ts";

const FS_ROOTS_HEADER = "[[filesystem.roots]]";

let dir: string;

beforeEach(() => {
  // mkdtempSync, not join(tmpdir(), <guessable name>): it creates the directory
  // atomically with a random suffix and owner-only permissions, so a predictable
  // path in a world-writable dir cannot be pre-created or symlinked by another
  // user. Matches the convention used across the rest of the suite.
  dir = mkdtempSync(join(tmpdir(), "nimbus-toml-write-"));
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
  // Runs on all three matrix platforms, and that is the point: an earlier
  // version escaped separators as `\\` and leaned on resolve() to collapse
  // them, which holds on Windows and FAILS on POSIX where a backslash is an
  // ordinary filename character. This is the regression test for that.
  const backslash = String.fromCharCode(92);
  const win = ["C:", "gitrep", "Nimbus"].join(backslash);
  appendFilesystemRoot(dir, win);
  const written = readFileSync(join(dir, "nimbus.toml"), "utf8");
  expect(hasFilesystemRoot(written, win)).toBe(true);
  expect(appendFilesystemRoot(dir, win).status).toBe("already-present");
});

test("the emitted path carries no backslash escapes to un-escape", () => {
  // Nothing on the read side un-escapes `\\` — not hasFilesystemRoot, and not
  // the gateway's own parseString. Not emitting them is what makes the
  // round-trip correct by construction rather than by platform accident.
  appendFilesystemRoot(dir, join(dir, "repo-a"));
  const pathLine = readFileSync(join(dir, "nimbus.toml"), "utf8")
    .split(/\r?\n/)
    .find((l) => l.trim().startsWith("path"));
  expect(pathLine).toBeDefined();
  expect(pathLine).not.toContain(String.fromCharCode(92));
});

test("hasFilesystemRoot still reads a hand-written escaped path", () => {
  // Backwards compatibility: a user (or an older writer) may well have put
  // `path = "C:\\repo"` in the file by hand, and reporting it as unconfigured
  // would silently append a duplicate root.
  const backslash = String.fromCharCode(92);
  const win = ["C:", "repo"].join(backslash);
  const escaped = ["C:", "repo"].join(backslash + backslash);
  const src = [FS_ROOTS_HEADER, `path = "${escaped}"`, ""].join("\n");
  expect(hasFilesystemRoot(src, win)).toBe(true);
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

test("a config path that exists but cannot be read is an error, never treated as absent", () => {
  // `readFileIfExists` may swallow ENOENT and nothing else: a nimbus.toml that is there but
  // unreadable (here a DIRECTORY, so EISDIR) must not be read as "no config yet" and then have a
  // fresh root appended to it.
  const tomlPath = join(dir, "nimbus.toml");
  mkdirSync(tomlPath);
  writeFileSync(join(tomlPath, "inside.txt"), "untouched", "utf8");
  let caught: unknown;
  try {
    appendFilesystemRoot(dir, join(dir, "repo-a"));
  } catch (e) {
    caught = e;
  }
  const err = caught as NodeJS.ErrnoException | undefined;
  expect(err?.code).toBe("EISDIR");
  // The failure must be the READ of the config. Swallowing it would still end in an EISDIR — from
  // the append onto the same directory — so the two are told apart by the failing syscall (`read`
  // vs `open` on Linux, `read` vs `write` on Windows). Both signatures are taken from this platform
  // rather than hard-coded, and the premise that they differ is asserted, not assumed.
  const syscallOf = (op: () => unknown): string | undefined => {
    try {
      op();
    } catch (e) {
      return (e as NodeJS.ErrnoException).syscall;
    }
    return undefined;
  };
  const readSyscall = syscallOf(() => readFileSync(tomlPath, "utf8"));
  const appendSyscall = syscallOf(() => writeFileSync(tomlPath, "x", { flag: "a" }));
  expect(readSyscall).toBeDefined();
  expect(appendSyscall).not.toBe(readSyscall);
  expect(err?.syscall).toBe(readSyscall);
  // Nothing was written: no backup beside it, and the directory's contents are as they were.
  expect(readdirSync(dir).sort((a, b) => a.localeCompare(b))).toEqual(["nimbus.toml"]);
  expect(readdirSync(tomlPath)).toEqual(["inside.txt"]);
  expect(readFileSync(join(tomlPath, "inside.txt"), "utf8")).toBe("untouched");
});

test("hasFilesystemRoot un-escapes an escaped quote inside a hand-written path", () => {
  // `\"` is how TOML spells a literal quote in a basic string; the comparison must see the quote,
  // not the backslash, or a root whose name contains one is reported unconfigured and re-added.
  const target = join(dir, 'a"b');
  const tomlValue = target.split(sep).join("/").replace('"', String.raw`\"`);
  const src = [FS_ROOTS_HEADER, `path = "${tomlValue}"`, ""].join("\n");
  expect(hasFilesystemRoot(src, target)).toBe(true);
  // Dropping the escaped character instead of un-escaping it would match this one.
  expect(hasFilesystemRoot(src, join(dir, "ab"))).toBe(false);
});

test("hasFilesystemRoot keeps a backslash that escapes anything else, rather than dropping it", () => {
  // Only `\\` and `\"` are un-escaped. `\t` is kept as the two characters it is, so the value is
  // compared exactly as written — on POSIX a backslash is an ordinary filename character, on
  // Windows a separator; either way both sides resolve the same string.
  const src = [FS_ROOTS_HEADER, String.raw`path = "/srv/a\tb"`, ""].join("\n");
  expect(hasFilesystemRoot(src, String.raw`/srv/a\tb`)).toBe(true);
  expect(hasFilesystemRoot(src, "/srv/atb")).toBe(false);
});

test("hasFilesystemRoot reads past a trailing comment on the header and on the path line", () => {
  // A hand-edited config annotates its roots. Unless the comment is stripped first, the header no
  // longer ends in `]` (so the block is never entered) and the quoted value runs into the comment —
  // either way an already-configured root would read as absent and `init` would append it again.
  const target = join(dir, "repo-a");
  const src = [
    `${FS_ROOTS_HEADER}  # the main checkout`,
    `path = "${target.split(sep).join("/")}"  # added by hand`,
    "",
  ].join("\n");
  expect(hasFilesystemRoot(src, target)).toBe(true);
  // A trailing comment is not a wildcard: a different root under the same block is still absent.
  expect(hasFilesystemRoot(src, join(dir, "repo-b"))).toBe(false);
});

test("a path value too short to be a quoted string is skipped, never resolved as the cwd", () => {
  // `path = "` has nothing between its quotes: slicing it would give "", and resolve("") is the
  // working directory — so without the length guard a broken line would claim the cwd as a root.
  const broken = [FS_ROOTS_HEADER, 'path = "', ""].join("\n");
  expect(hasFilesystemRoot(broken, process.cwd())).toBe(false);
  // Skipping the broken line does not stop the scan: a later valid root is still found.
  const target = join(dir, "repo-a");
  const withValid = [
    FS_ROOTS_HEADER,
    'path = "',
    FS_ROOTS_HEADER,
    `path = "${target.split(sep).join("/")}"`,
    "",
  ].join("\n");
  expect(hasFilesystemRoot(withValid, target)).toBe(true);
});

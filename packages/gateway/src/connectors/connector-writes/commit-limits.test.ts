// packages/gateway/src/connectors/connector-writes/commit-limits.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { installedConnectorsPackageRoot } from "../testing/connector-write-registrations.ts";
import {
  COMMIT_INPUT_REFUSALS,
  COMMIT_LIMITS,
  commitInputRefusal,
  isSafeCommitPathGateway,
} from "./commit-limits.ts";

const ok = (n = 1) => ({
  message: "msg",
  files: Array.from({ length: n }, (_, i) => ({ path: `src/f${String(i)}.ts`, content: "x\n" })),
});

describe("COMMIT_LIMITS", () => {
  test("pins the owner-ruled numbers", () => {
    expect(COMMIT_LIMITS.maxFiles).toBe(20);
    expect(COMMIT_LIMITS.maxNewContentBytes).toBe(32 * 1024);
    expect(COMMIT_LIMITS.maxOldContentBytes).toBe(32 * 1024);
    expect(COMMIT_LIMITS.maxDiffBytes).toBe(65_536);
    expect(COMMIT_LIMITS.maxInputChars).toBe(96 * 1024);
    expect(COMMIT_LIMITS.maxReplyChars).toBe(262_144);
    expect(Object.isFrozen(COMMIT_LIMITS)).toBe(true);
  });

  test("relationships: the gateway is tighter than the connector, the diff fits one IPC line", () => {
    // The connector's combined cap is 192 KiB; old + new here is 64 KiB.
    expect(COMMIT_LIMITS.maxNewContentBytes + COMMIT_LIMITS.maxOldContentBytes).toBeLessThan(
      192 * 1024,
    );
    // The JSON backstop allows the new content with escaping headroom (a quote or backslash doubles).
    expect(COMMIT_LIMITS.maxInputChars).toBeGreaterThan(COMMIT_LIMITS.maxNewContentBytes);
    // A reply carries up to 32 KiB of old content per the cap, escaped at worst twice.
    expect(COMMIT_LIMITS.maxReplyChars).toBeGreaterThan(COMMIT_LIMITS.maxOldContentBytes * 2);
    // The diff travels twice in consent.request (prompt and details) and each frame is < 1 MiB.
    // (the structured copy is up to ~24 bytes per 2-byte diff line: ipc/consent-diff-frame.test.ts
    // measures the real worst case, about 785 KB)
    expect(
      (COMMIT_LIMITS.maxDiffBytes / 2) * 24 + COMMIT_LIMITS.maxDiffBytes * 2 + 64 * 1024,
    ).toBeLessThan(1024 * 1024);
    expect(COMMIT_LIMITS.maxDiffBytes).toBeGreaterThan(COMMIT_LIMITS.maxNewContentBytes);
  });
});

describe("commitInputRefusal", () => {
  test("accepts a 20-file input at the limit", () => {
    expect(commitInputRefusal(ok(20))).toBeUndefined();
  });

  test.each([
    ["files absent", { message: "m" }, "filesInvalid"],
    ["files not an array", { message: "m", files: "x" }, "filesInvalid"],
    ["files empty", { message: "m", files: [] }, "filesInvalid"],
    ["21 files", ok(21), "filesInvalid"],
    ["a non-object entry", { message: "m", files: ["a"] }, "fileInvalid"],
    ["a null entry", { message: "m", files: [null] }, "fileInvalid"],
    ["an array entry", { message: "m", files: [[]] }, "fileInvalid"],
    [
      "an extra key",
      { message: "m", files: [{ path: "a", content: "x", mode: "100755" }] },
      "fileInvalid",
    ],
    ["a non-string path", { message: "m", files: [{ path: 1, content: "x" }] }, "fileInvalid"],
    ["a non-string content", { message: "m", files: [{ path: "a", content: 1 }] }, "fileInvalid"],
    [
      "duplicate paths",
      {
        message: "m",
        files: [
          { path: "a", content: "x" },
          { path: "a", content: "y" },
        ],
      },
      "duplicatePath",
    ],
    ["NUL in content", { message: "m", files: [{ path: "a", content: "a\u0000b" }] }, "contentBad"],
    [
      "a lone surrogate",
      { message: "m", files: [{ path: "a", content: "a\ud800b" }] },
      "contentBad",
    ],
    ["empty message", { message: "", files: [{ path: "a", content: "x" }] }, "messageInvalid"],
    ["no message", { files: [{ path: "a", content: "x" }] }, "messageInvalid"],
    [
      "a non-string message",
      { message: 5, files: [{ path: "a", content: "x" }] },
      "messageInvalid",
    ],
    [
      "a message over the connector's 5000",
      { message: "m".repeat(5001), files: [{ path: "a", content: "x" }] },
      "messageInvalid",
    ],
    ["an unsafe path", { message: "m", files: [{ path: "../a", content: "x" }] }, "pathUnsafe"],
  ] as const)("refuses %s", (_name, input, key) => {
    expect(commitInputRefusal(input as Record<string, unknown>)).toBe(COMMIT_INPUT_REFUSALS[key]);
  });

  test("content over 32 KiB in total is refused; exactly 32 KiB passes (UTF-8 bytes)", () => {
    const at = { message: "m", files: [{ path: "a", content: "a".repeat(32 * 1024) }] };
    expect(commitInputRefusal(at)).toBeUndefined();
    const over = { message: "m", files: [{ path: "a", content: "a".repeat(32 * 1024 + 1) }] };
    expect(commitInputRefusal(over)).toBe(COMMIT_INPUT_REFUSALS.contentTooLarge);
    const across = {
      message: "m",
      files: [
        { path: "a", content: "a".repeat(16 * 1024) },
        { path: "b", content: "b".repeat(16 * 1024 + 1) },
      ],
    };
    expect(commitInputRefusal(across)).toBe(COMMIT_INPUT_REFUSALS.contentTooLarge);
  });

  test("multi-byte characters are counted in UTF-8: one 4-byte code point at the edge", () => {
    const edge = {
      message: "m",
      files: [{ path: "a", content: `${"a".repeat(32 * 1024 - 4)}😀` }],
    };
    expect(commitInputRefusal(edge)).toBeUndefined();
    const past = {
      message: "m",
      files: [{ path: "a", content: `${"a".repeat(32 * 1024 - 3)}😀` }],
    };
    expect(commitInputRefusal(past)).toBe(COMMIT_INPUT_REFUSALS.contentTooLarge);
    // 11,000 three-byte characters are 33,000 bytes though only 11,000 characters.
    const wide = { message: "m", files: [{ path: "a", content: "€".repeat(11_000) }] };
    expect(commitInputRefusal(wide)).toBe(COMMIT_INPUT_REFUSALS.contentTooLarge);
  });

  test("a null-prototype input and entries are plain objects too", () => {
    const entry = Object.assign(Object.create(null), { path: "a", content: "x" });
    const input = Object.assign(Object.create(null), { message: "m", files: [entry] });
    expect(commitInputRefusal(input)).toBeUndefined();
  });

  test("not an object is refused", () => {
    expect(commitInputRefusal(null as unknown as Record<string, unknown>)).toBe(
      COMMIT_INPUT_REFUSALS.filesInvalid,
    );
  });

  test("path safety runs before the content checks and on every file", () => {
    const input = {
      message: "m",
      files: [
        { path: "ok.ts", content: "x" },
        { path: "./.github/workflows/x.yml", content: "a\u0000" },
      ],
    };
    expect(commitInputRefusal(input)).toBe(COMMIT_INPUT_REFUSALS.pathUnsafe);
  });

  test("every reason is a frozen constant and carries no input text", () => {
    expect(Object.isFrozen(COMMIT_INPUT_REFUSALS)).toBe(true);
    const marker = "ZZ-MARKER-ZZ";
    const bad = [
      { message: "", files: [{ path: `../${marker}`, content: marker }] },
      { message: marker, files: [{ path: marker, content: `${marker}\u0000` }] },
      { message: marker, files: [{ path: marker, content: marker, extra: marker }] },
      {
        message: marker,
        files: [
          { path: marker, content: "x" },
          { path: marker, content: "y" },
        ],
      },
    ];
    for (const input of bad) {
      const r = commitInputRefusal(input as unknown as Record<string, unknown>);
      expect(r).toBeDefined();
      expect(Object.values(COMMIT_INPUT_REFUSALS) as string[]).toContain(r as string);
      expect(String(r)).not.toContain(marker);
    }
  });
});

describe("isSafeCommitPathGateway is pinned against the connector's isSafeCommitPath", () => {
  // Cases shared with the connector's own tests: every one of them must get the same answer.
  const SHARED: readonly string[] = [
    "a",
    "src/a.ts",
    "a/b/c/d.md",
    "docs/readme.md",
    ".github/workflows/ci.yml",
    "",
    "/a",
    "a/",
    "a//b",
    "a\\b",
    ".",
    "..",
    "./a",
    "a/./b",
    "a/../b",
    "../a",
    "a/..",
    ".git",
    ".git/config",
    "a/.git/hooks",
    ".GIT",
    ".git.",
    ".git ",
    "GIT~1",
    "a/git~1/x",
    "...",
    "a/ /b",
    "a\u0000b",
    "a\u0007b",
    "a\u001bb",
    "a\u007fb",
    "a\u0085b",
    "a\u009fb",
    "a\u202eb",
    "a\u200bb",
    "a\u2066b",
    "a\ufeffb",
    "a b",
    "a b",
    "a\ud800b",
    "a\udfffb",
    "é.md",
    "a\tb",
    "a\nb",
    "x".repeat(1024),
    "x".repeat(1025),
    ".github/CODEOWNERS",
    "a b/c d.txt",
  ];

  test("the same answer on every shared case", async () => {
    const mod = (await import(
      join(installedConnectorsPackageRoot(), "shared", "commit-files.ts")
    )) as { isSafeCommitPath: (p: string) => boolean };
    for (const p of SHARED) {
      expect(isSafeCommitPathGateway(p), JSON.stringify(p)).toBe(mod.isSafeCommitPath(p));
    }
  });

  test("the gateway is stricter in exactly one way: a path that is not NFC", async () => {
    const mod = (await import(
      join(installedConnectorsPackageRoot(), "shared", "commit-files.ts")
    )) as { isSafeCommitPath: (p: string) => boolean };
    const decomposed = "é.md"; // e + combining acute: NFD
    expect(mod.isSafeCommitPath(decomposed)).toBe(true);
    expect(isSafeCommitPathGateway(decomposed)).toBe(false);
    expect(isSafeCommitPathGateway(decomposed.normalize("NFC"))).toBe(true);
  });
});

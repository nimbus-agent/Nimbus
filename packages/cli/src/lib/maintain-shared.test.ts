import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  httpsUrl,
  isSameOrInside,
  parseArgs,
  requestFrom,
  resolveActionPin,
  resolveDefaultBranch,
  slugOf,
  splitIdVersion,
  writeKeyFile,
  writeRequestJson,
} from "./maintain-shared.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const FP = "0123456789abcdef0123456789abcdef";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-maintain-shared-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const args = (list: string[], valued: string[] = ["--action-ref", "--default-branch"]) =>
  parseArgs(list, valued, []);

describe("resolveActionPin", () => {
  test("an --action-ref wins over the build's commit", () => {
    const pin = resolveActionPin(args(["--action-ref", SHA]), {
      releaseCommit: "f".repeat(40),
      version: "1.2.3",
    });
    expect(pin).toEqual({ commit: SHA, version: "1.2.3" });
  });

  test("the build's commit is used when none is given", () => {
    expect(resolveActionPin(args([]), { releaseCommit: SHA, version: "9.9.9" }).commit).toBe(SHA);
  });

  test("a build with no commit and no flag asks for --action-ref", () => {
    expect(() => resolveActionPin(args([]), { releaseCommit: undefined, version: "1" })).toThrow(
      "pass --action-ref <40-hex commit SHA>",
    );
  });

  test("a bad flag and a bad embedded commit are refused with different messages", () => {
    expect(() =>
      resolveActionPin(args(["--action-ref", "ABC"]), { releaseCommit: SHA, version: "1" }),
    ).toThrow("--action-ref must be a 40-hex lowercase commit SHA");
    expect(() => resolveActionPin(args([]), { releaseCommit: "dev", version: "1" })).toThrow(
      "embedded release commit is not a 40-hex SHA (dev)",
    );
  });
});

describe("resolveDefaultBranch", () => {
  test("defaults to main and accepts a plain branch", () => {
    expect(resolveDefaultBranch(args([]))).toBe("main");
    expect(resolveDefaultBranch(args(["--default-branch", "release/1.x"]))).toBe("release/1.x");
  });

  test.each(["-x", ".x", "a..b", "a//b", "a/.b", "a/", "a.", "a.lock", "a b"])(
    "refuses %s",
    (b) => {
      expect(() => resolveDefaultBranch(args(["--default-branch", b]))).toThrow(
        "--default-branch must be a plain branch name",
      );
    },
  );
});

describe("small helpers", () => {
  test("isSameOrInside", () => {
    expect(isSameOrInside(join(dir, "a", "b"), dir)).toBe(true);
    expect(isSameOrInside(dir, dir)).toBe(true);
    expect(isSameOrInside(join(dir, ".."), dir)).toBe(false);
  });

  test("splitIdVersion splits only on a semver suffix", () => {
    expect(splitIdVersion("pkg@1.2.3")).toEqual({ id: "pkg", version: "1.2.3" });
    expect(splitIdVersion("@scope/pkg")).toEqual({ id: "@scope/pkg", version: undefined });
    expect(splitIdVersion("pkg@latest")).toEqual({ id: "pkg@latest", version: undefined });
  });

  test("httpsUrl normalises https and names the option it refuses", () => {
    expect(httpsUrl("https://a.example", "the url")).toBe("https://a.example/");
    expect(() => httpsUrl("nope", "the url")).toThrow("the url is not a URL");
    expect(() => httpsUrl("http://a.example", "the url")).toThrow("the url must be an https: URL");
  });

  test("slugOf makes a file-safe, bounded slug", () => {
    expect(slugOf("Acme/Tool X")).toBe("acme-toolx");
    expect(slugOf("a".repeat(200)).length).toBe(64 - "takedown-".length - 1 - 8);
  });

  test("parseArgs refuses a missing value and an unknown option", () => {
    expect(() => parseArgs(["--key"], ["--key"], [])).toThrow("--key needs a value");
    expect(() => parseArgs(["--key", "--other"], ["--key"], [])).toThrow("--key needs a value");
    expect(() => parseArgs(["--zzz"], [], [])).toThrow("unknown option --zzz");
  });
});

describe("writeKeyFile", () => {
  test("refuses to overwrite without force, overwrites with it", () => {
    const path = join(dir, "sub", "key");
    writeKeyFile(path, new Uint8Array(32).fill(1), false);
    expect(() => writeKeyFile(path, new Uint8Array(32).fill(2), false)).toThrow(
      `refusing to overwrite ${path} without --force`,
    );
    writeKeyFile(path, new Uint8Array(32).fill(2), true);
    expect(Buffer.from(readFileSync(path, "utf8").trim(), "base64")[0]).toBe(2);
  });
});

describe("requestFrom", () => {
  const opts = (list: string[]) => parseArgs(list, ["--reason", "--publisher"], []);

  test("needs a reason, and a publisher for a key revocation", () => {
    expect(() => requestFrom("key.revoke", opts([]), FP)).toThrow("--reason <text> is required");
    expect(() => requestFrom("key.revoke", opts(["--reason", "leaked"]), FP)).toThrow(
      "revoke-key needs --publisher <id>",
    );
  });

  test("a takedown can require the publisher and defaults to every version", () => {
    expect(() =>
      requestFrom("extension.takedown", opts(["--reason", "bad"]), "acme.tool", true),
    ).toThrow("takedown needs --publisher <id>");
    const all = requestFrom("extension.takedown", opts(["--reason", "bad"]), "acme.tool");
    expect(all).toMatchObject({ kind: "extension.takedown", versions: "*" });
    const one = requestFrom("extension.takedown", opts(["--reason", "bad"]), "acme.tool@1.0.0");
    expect(one).toMatchObject({ versions: ["1.0.0"] });
  });
});

describe("writeRequestJson", () => {
  test("writes once, reports an identical rewrite as same, refuses changed content", () => {
    const req = requestFrom(
      "key.revoke",
      parseArgs(["--reason", "leaked", "--publisher", "acme"], ["--reason", "--publisher"], []),
      FP,
    );
    const first = writeRequestJson(dir, "trust-requests", req);
    expect(first.status).toBe("written");
    expect(writeRequestJson(dir, "trust-requests", req)).toEqual({
      path: first.path,
      status: "same",
    });
    writeFileSync(first.path, "changed");
    expect(() => writeRequestJson(dir, "trust-requests", req)).toThrow(
      "exists with different content",
    );
  });
});

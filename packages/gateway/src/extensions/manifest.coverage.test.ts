/**
 * Refusals of the extension-manifest parser that `manifest.test.ts` does not reach: a `publisher`
 * that is not an object or carries non-string fields, a non-string `signature`, and every shape of
 * malformed `dependsOn` — plus the empty `dependsOn` that normalises away, `name` normalisation,
 * and which manifest FILE a directory resolves to. The signed-manifest path (I16) parses through
 * exactly these functions, so each refusal is pinned to its own message.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXTENSION_MANIFEST_FILENAME,
  EXTENSION_MANIFEST_FILENAME_LEGACY,
  parseExtensionManifestForRegistry,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "./manifest.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const KEY = `${"A".repeat(43)}=`;
const SIG = `${"B".repeat(86)}==`;

function parse(extra: Record<string, unknown>): ReturnType<typeof parseExtensionManifestJson> {
  return parseExtensionManifestJson(
    JSON.stringify({ id: "com.cov.m", version: "1.0.0", ...extra }),
  );
}

function messageOf(extra: Record<string, unknown>): string {
  try {
    parse(extra);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the manifest to be refused");
}

describe("publisher", () => {
  test.each([
    ["null", null],
    ["an array", [{ id: "acme", key: KEY }]],
    ["a string", "acme"],
  ])("a publisher that is %s is refused as not an object", (_label, publisher) => {
    const msg = messageOf({ publisher, signature: SIG });
    expect(msg).toBe("extension manifest publisher must be an object");
  });

  test("a non-string publisher.id is refused as missing, not coerced", () => {
    const msg = messageOf({ publisher: { id: 42, key: KEY }, signature: SIG });
    expect(msg).toStartWith("extension manifest publisher.id is required");
    expect(msg).not.toContain("publisher.key");
  });

  test("a non-string publisher.key is refused as malformed, not coerced", () => {
    const msg = messageOf({ publisher: { id: "acme", key: 12345 }, signature: SIG });
    expect(msg).toStartWith("extension manifest publisher.key must be 44-char base64");
    expect(msg).not.toContain("publisher.id");
  });

  test("surrounding whitespace on id and key is trimmed rather than refused", () => {
    const { manifest } = parseExtensionManifestForRegistry(
      JSON.stringify({
        id: "com.cov.m",
        version: "1.0.0",
        publisher: { id: "  acme  ", key: ` ${KEY} ` },
        signature: SIG,
      }),
    );
    expect(manifest.publisher).toEqual({ id: "acme", key: KEY });
  });
});

describe("signature", () => {
  test("a non-string signature is refused by type, before its format is examined", () => {
    const msg = messageOf({ publisher: { id: "acme", key: KEY }, signature: 1234 });
    expect(msg).toBe("extension manifest signature must be a string");
  });
});

describe("dependsOn", () => {
  test.each([
    ["null", null],
    ["an array", ["com.cov.dep"]],
    ["a string", "com.cov.dep@^1.0.0"],
  ])("a dependsOn that is %s is refused as not an object", (_label, dependsOn) => {
    expect(messageOf({ dependsOn })).toBe("extension manifest dependsOn must be an object");
  });

  test("a blank dependency id is refused", () => {
    expect(messageOf({ dependsOn: { "  ": "^1.0.0" } })).toBe(
      "extension manifest dependsOn keys must be non-empty strings",
    );
  });

  test.each([
    ["a number", 1],
    ["blank", "   "],
    ["null", null],
  ])("a range that is %s is refused, naming the dependency", (_label, range) => {
    const msg = messageOf({ dependsOn: { "com.cov.dep": range } });
    expect(msg).toBe("extension manifest dependsOn.com.cov.dep must be a non-empty string");
    expect(msg).not.toContain("not a valid semver range");
  });

  test("an EMPTY dependsOn normalises to absent, so it reads like a zero-dependency extension", () => {
    const m = parse({ dependsOn: {} });
    expect(m.dependsOn).toBeUndefined();
    expect("dependsOn" in m).toBe(false);
  });
});

describe("identity fields", () => {
  test("a non-string id is refused as missing rather than stringified", () => {
    expect(() => parseExtensionManifestJson(JSON.stringify({ id: 42, version: "1.0.0" }))).toThrow(
      "extension manifest requires non-empty id and version",
    );
  });

  test("a name is trimmed; a blank or non-string name is omitted rather than kept empty", () => {
    expect(parse({ name: "  Widget Pro  " }).name).toBe("Widget Pro");
    expect("name" in parse({ name: "   " })).toBe(false);
    expect("name" in parse({ name: 7 })).toBe(false);
  });
});

describe("resolveExtensionManifestPath", () => {
  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), "nimbus-manifest-cov-"));
    dirs.push(d);
    return d;
  }

  test("a directory with no manifest resolves to undefined", () => {
    expect(resolveExtensionManifestPath(tempDir())).toBeUndefined();
  });

  test("the legacy filename is still found when it is the only one", () => {
    const d = tempDir();
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY), "{}");
    expect(resolveExtensionManifestPath(d)).toBe(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY));
  });

  test("the current filename wins when both are present", () => {
    const d = tempDir();
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME_LEGACY), "{}");
    writeFileSync(join(d, EXTENSION_MANIFEST_FILENAME), "{}");
    expect(resolveExtensionManifestPath(d)).toBe(join(d, EXTENSION_MANIFEST_FILENAME));
  });
});

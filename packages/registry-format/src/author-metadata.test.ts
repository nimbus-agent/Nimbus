import { describe, expect, test } from "bun:test";
import {
  assertAuthorMetadata,
  authorMetadataView,
  readManifestFunding,
  readManifestLicense,
} from "./author-metadata.ts";
import { RegistryError } from "./errors.ts";

const RLO = String.fromCodePoint(0x202e);
const url = (n: number): string => `https://x.com/${"a".repeat(n - "https://x.com/".length)}`;

describe("readManifestFunding", () => {
  test("absent", () => {
    expect(readManifestFunding({})).toEqual({ kind: "absent" });
    expect(readManifestFunding("nope")).toEqual({ kind: "absent" });
  });

  test("ok keeps labels, omits a missing one", () => {
    const r = readManifestFunding({
      funding: [
        { url: "https://github.com/sponsors/acme", label: "GitHub Sponsors" },
        { url: "https://ko-fi.com/acme" },
      ],
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.value[0]).toEqual({
      url: "https://github.com/sponsors/acme",
      label: "GitHub Sponsors",
    });
    expect("label" in (r.value[1] ?? {})).toBe(false);
  });

  const bad: Array<[string, unknown, string]> = [
    ["not an array", "x", "array"],
    ["empty", [], "entries"],
    [
      "nine entries",
      Array.from({ length: 9 }, (_, i) => ({ url: `https://x.com/${i}` })),
      "entries",
    ],
    ["entry not object", ["x"], "not an object"],
    ["extra key", [{ url: "https://x.com", label: "a", icon: "b" }], "unknown key"],
    ["http", [{ url: "http://x.com" }], "https"],
    ["javascript", [{ url: "javascript:alert(1)" }], "https"],
    ["file", [{ url: "file:///etc/passwd" }], "https"],
    ["userinfo", [{ url: "https://user:pw@x.com/" }], "https"],
    ["no host", [{ url: "https://" }], "https"],
    ["long url", [{ url: url(2049) }], "https"],
    ["duplicate", [{ url: "https://x.com" }, { url: "https://x.com" }], "repeats"],
    ["empty label", [{ url: "https://x.com", label: "" }], "label"],
    ["long label", [{ url: "https://x.com", label: "a".repeat(65) }], "label"],
    ["control label", [{ url: "https://x.com", label: "\u001b[31m" }], "control"],
    ["bidi label", [{ url: "https://x.com", label: `a${RLO}b` }], "bidi"],
  ];
  for (const [name, funding, frag] of bad) {
    test(`invalid: ${name}`, () => {
      const r = readManifestFunding({ funding });
      expect(r.kind).toBe("invalid");
      if (r.kind === "invalid") expect(r.reason).toContain(frag);
    });
  }

  test("an exactly 2048-character url is accepted", () => {
    expect(readManifestFunding({ funding: [{ url: url(2048) }] }).kind).toBe("ok");
  });
});

describe("readManifestLicense", () => {
  test("absent", () => {
    expect(readManifestLicense({})).toEqual({ kind: "absent" });
  });
  for (const l of [
    "MIT",
    "Apache-2.0",
    "MIT OR Apache-2.0",
    "(MIT OR Apache-2.0) AND BSD-3-Clause",
    "Apache-2.0 WITH LLVM-exception",
    "LicenseRef-Acme-1.0",
    "GPL-2.0-or-later",
    "GPL-2.0+",
  ]) {
    test(`ok: ${l}`, () => {
      expect(readManifestLicense({ license: l })).toEqual({ kind: "ok", value: l });
    });
  }
  for (const l of [
    "",
    42,
    "MIT OR",
    "OR MIT",
    "MIT AND AND BSD",
    "(MIT",
    "MIT)",
    "MIT WITH",
    "MIT WITH (X)",
    "M I T",
    "a".repeat(129),
    "MIT\n",
  ]) {
    test(`invalid: ${JSON.stringify(l)}`, () => {
      expect(readManifestLicense({ license: l }).kind).toBe("invalid");
    });
  }
});

describe("authorMetadataView", () => {
  test("absent", () => {
    expect(authorMetadataView({})).toEqual({ funding: null, license: null });
  });
  test("ok", () => {
    expect(authorMetadataView({ funding: [{ url: "https://x.com" }], license: "MIT" })).toEqual({
      funding: [{ url: "https://x.com" }],
      license: "MIT",
    });
  });
  test("invalid", () => {
    expect(authorMetadataView({ funding: [], license: "MIT OR" })).toEqual({
      funding: null,
      fundingInvalid: true,
      license: null,
      licenseInvalid: true,
    });
  });
});

describe("assertAuthorMetadata", () => {
  test("throws on a malformed license with a prefixed detail", () => {
    let caught: unknown;
    try {
      assertAuthorMetadata({ license: "MIT OR" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RegistryError);
    const err = caught as RegistryError;
    expect(err.code).toBe("ERR_REGISTRY_MANIFEST_INVALID");
    expect(err.detail.startsWith("license: ")).toBe(true);
    expect(err.message.startsWith("ERR_REGISTRY_MANIFEST_INVALID: license: ")).toBe(true);
  });
  test("throws on funding", () => {
    expect(() => assertAuthorMetadata({ funding: [] })).toThrow(/funding: /);
  });
  test("passes when absent", () => {
    expect(() => assertAuthorMetadata({})).not.toThrow();
  });
});

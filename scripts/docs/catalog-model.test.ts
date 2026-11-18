import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Catalog,
  extensionHref,
  filterCatalog,
  installCommand,
  isHttpsUrl,
  pagedExtensions,
  parseCatalog,
} from "../../packages/docs/src/lib/catalog.ts";

const SNAPSHOT = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "docs",
  "src",
  "data",
  "official-registry.json",
);

function ext(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme.tool",
    displayName: "Acme",
    description: "d",
    publisherId: "acme",
    publisherFingerprint: "f",
    verifiedPublisher: null,
    kind: "connector",
    newest: "1.0.0",
    network: [],
    filesRead: [],
    filesWrite: [],
    license: null,
    funding: [],
    provenance: null,
    baseline: "b",
    tested: "t",
    history: "h",
    versions: [
      {
        version: "1.0.0",
        channel: "stable",
        publishedAt: "2026-11-01T00:00:00Z",
        packageSizeBytes: 1,
        blocked: false,
        quality: { score: 90, cases: 10, passed: 9 },
      },
    ],
    ...over,
  };
}

function snap(extensions: unknown[]): Record<string, unknown> {
  return {
    format: 1,
    registry: "nimbus-official",
    sequence: 1,
    generatedAt: "g",
    snapshotAt: "s",
    extensions,
  };
}

describe("the committed catalog snapshot", () => {
  test("parses, so the docs build can render it", () => {
    const c = parseCatalog(JSON.parse(readFileSync(SNAPSHOT, "utf8")) as unknown);
    expect(c.registry).toBe("nimbus-official");
    expect(c.extensions.length).toBeGreaterThan(0);
  });
});

describe("parseCatalog", () => {
  test("accepts a well-formed snapshot and drops a non-https funding link", () => {
    const c = parseCatalog(
      snap([
        ext({
          funding: [
            { url: "javascript:alert(1)", label: "x" },
            { url: "https://sponsor.example/", label: null },
          ],
          provenance: { sourceRepository: "https://github.com/a/b", commit: "c" },
        }),
      ]),
    );
    expect(c.extensions[0]?.funding).toEqual([{ url: "https://sponsor.example/", label: null }]);
    expect(c.extensions[0]?.provenance?.commit).toBe("c");
  });

  test("refuses malformed input, naming the field", () => {
    expect(() => parseCatalog(null)).toThrow(/not an object/);
    expect(() => parseCatalog({ ...snap([]), format: 2 })).toThrow(/format/);
    expect(() => parseCatalog({ ...snap([]), extensions: {} })).toThrow(/extensions is not a list/);
    expect(() => parseCatalog(snap([ext({ kind: "plugin" })]))).toThrow(/kind is unknown/);
    expect(() => parseCatalog(snap([ext({ network: [1] })]))).toThrow(/list of strings/);
    expect(() => parseCatalog(snap([ext({ versions: "x" })]))).toThrow(/versions is not a list/);
    expect(() => parseCatalog(snap([ext({ funding: "x" })]))).toThrow(/funding is not a list/);
    expect(() =>
      parseCatalog(
        snap([ext({ versions: [{ ...(ext()["versions"] as object[])[0], blocked: "no" }] })]),
      ),
    ).toThrow(/blocked/);
    expect(() => parseCatalog(snap([ext({ displayName: 3 })]))).toThrow(/displayName/);
    expect(() => parseCatalog({ ...snap([]), sequence: "1" })).toThrow(/sequence/);
  });
});

describe("filters, routes and commands", () => {
  const c: Catalog = parseCatalog(
    snap([
      ext(),
      ext({ id: "b.pack", kind: "starter-pack", verifiedPublisher: "acme-gh", versions: [] }),
      ext({ id: "verified", kind: "other" }),
    ]),
  );

  test("filters by verified publisher, score and kind; a reserved id gets no page", () => {
    expect(pagedExtensions(c).map((e) => e.id)).toEqual(["acme.tool", "b.pack"]);
    expect(filterCatalog(c, { verified: true }).map((e) => e.id)).toEqual(["b.pack"]);
    expect(filterCatalog(c, { scored: true }).map((e) => e.id)).toEqual(["acme.tool"]);
    expect(filterCatalog(c, { kind: "starter-pack" }).map((e) => e.id)).toEqual(["b.pack"]);
  });

  test("builds an href per id segment and an install command only for a publishable id", () => {
    expect(extensionHref("acme/my tool")).toBe("/extensions/acme/my%20tool/");
    expect(installCommand("com.acme.tool")).toBe("nimbus extension install com.acme.tool");
    for (const bad of ["", "a b", "$(x)", "a/", "x.lock", "a.", "a".repeat(129)]) {
      expect(installCommand(bad)).toBeNull();
    }
    expect(isHttpsUrl("https://x.example/")).toBe(true);
    expect(isHttpsUrl("http://x.example/")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
  });
});

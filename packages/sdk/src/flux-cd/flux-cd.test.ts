import { describe, expect, it } from "bun:test";
import { FLUX_KINDS, trimTrailingSlash } from "./index.ts";

describe("FLUX_KINDS", () => {
  it("has exactly 9 entries", () => {
    expect(FLUX_KINDS.length).toBe(9);
  });

  it("every entry has non-empty kind, group, version, plural", () => {
    for (const entry of FLUX_KINDS) {
      expect(entry.kind.length).toBeGreaterThan(0);
      expect(entry.group.length).toBeGreaterThan(0);
      expect(entry.version.length).toBeGreaterThan(0);
      expect(entry.plural.length).toBeGreaterThan(0);
    }
  });

  it("contains kustomization as the first entry", () => {
    const first = FLUX_KINDS[0];
    expect(first).toBeDefined();
    expect(first?.kind).toBe("kustomization");
    expect(first?.group).toBe("kustomize.toolkit.fluxcd.io");
    expect(first?.version).toBe("v1");
    expect(first?.plural).toBe("kustomizations");
  });

  it("contains helm_release with v2 version", () => {
    const entry = FLUX_KINDS.find((e) => e.kind === "helm_release");
    expect(entry).toBeDefined();
    expect(entry?.version).toBe("v2");
    expect(entry?.plural).toBe("helmreleases");
  });

  it("contains image_update_automation with v1beta1", () => {
    const entry = FLUX_KINDS.find((e) => e.kind === "image_update_automation");
    expect(entry).toBeDefined();
    expect(entry?.version).toBe("v1beta1");
    expect(entry?.plural).toBe("imageupdateautomations");
  });

  it("all kinds are unique", () => {
    const kinds = FLUX_KINDS.map((e) => e.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(kinds.length);
  });
});

describe("trimTrailingSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimTrailingSlash("https://example.com/")).toBe("https://example.com");
  });

  it("leaves a string without trailing slash unchanged", () => {
    expect(trimTrailingSlash("https://example.com")).toBe("https://example.com");
  });

  it("removes only the last slash (not multiple)", () => {
    // Only strips one trailing slash — the function is s.endsWith("/") ? s.slice(0,-1) : s
    expect(trimTrailingSlash("https://example.com//")).toBe("https://example.com/");
  });

  it("handles empty string", () => {
    expect(trimTrailingSlash("")).toBe("");
  });

  it("handles a bare slash", () => {
    expect(trimTrailingSlash("/")).toBe("");
  });
});

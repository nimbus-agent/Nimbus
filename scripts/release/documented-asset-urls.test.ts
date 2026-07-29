import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  documentedAssetNames,
  findDeadDocumentedUrls,
  stagedAssetNames,
} from "./documented-asset-urls.ts";

const ROOT = join(import.meta.dir, "..", "..");

describe("stagedAssetNames", () => {
  test("takes the basename for a bare dist/stage/ destination", () => {
    expect(stagedAssetNames("          cp scripts/install/unix/install.sh   dist/stage/")).toEqual(
      new Set(["install.sh"]),
    );
  });

  test("takes the destination name when the cp renames", () => {
    const yaml = `          cp "dist/stage/nimbus-headless_1.2.3_amd64.deb" dist/stage/nimbus_amd64.deb`;
    expect(stagedAssetNames(yaml)).toEqual(new Set(["nimbus_amd64.deb"]));
  });

  test("ignores globs — a run-time expansion is not a name we can promise", () => {
    // Treating `cp dist/installers/* dist/stage/` as satisfying any documented URL
    // is precisely what let the versioned-vs-unversioned AppImage mismatch survive.
    expect(stagedAssetNames("          cp dist/installers/*  dist/stage/")).toEqual(new Set());
  });

  test("ignores a variable-interpolated destination", () => {
    // The fixture must contain a literal dollar-brace interpolation, and both
    // obvious spellings trip a linter:
    //   - a template literal with a backslash-escaped dollar → CodeQL
    //     js/useless-regexp-character-escape (alert 161), because the escape
    //     collapses to the regex meta-character `$`. That is a FALSE POSITIVE
    //     here — this string is a YAML fixture, never a regex source — but it
    //     is avoidable, so avoid it rather than suppress it.
    //   - a plain-quoted string → Biome suspicious/noTemplateCurlyInString.
    // Interpolating the dollar needs neither, and the value is unchanged.
    const DOLLAR = "$";
    const yaml = `          cp dist/sbom.cdx.json "dist/stage/nimbus-${DOLLAR}{GITHUB_REF_NAME}-sbom.cdx.json"`;
    // Guards the fixture, not the code: `toEqual(new Set())` also passes on a
    // fixture that lost its interpolation entirely, which would make this test
    // silently stop testing anything.
    expect(yaml.includes(`${DOLLAR}{GITHUB_REF_NAME}`)).toBe(true);
    expect(stagedAssetNames(yaml)).toEqual(new Set());
  });
});

describe("documentedAssetNames", () => {
  test("collects every referenced filename with the docs that reference it", () => {
    const got = documentedAssetNames([
      { path: "README.md", text: "curl .../releases/latest/download/install.sh -o x" },
      { path: "docs/a.md", text: "irm .../releases/latest/download/install.ps1" },
      { path: "docs/b.md", text: "also .../releases/latest/download/install.ps1" },
    ]);
    expect(got.get("install.sh")).toEqual(["README.md"]);
    expect(got.get("install.ps1")).toEqual(["docs/a.md", "docs/b.md"]);
  });
});

describe("findDeadDocumentedUrls", () => {
  test("flags a documented name the workflow never stages", () => {
    const dead = findDeadDocumentedUrls(new Map([["install.ps1", ["README.md"]]]), new Set());
    expect(dead).toEqual([{ name: "install.ps1", referencedIn: ["README.md"] }]);
  });

  test("SHA256SUMS is generated, not copied — not a dead link", () => {
    const dead = findDeadDocumentedUrls(new Map([["SHA256SUMS", ["docs/verify.md"]]]), new Set());
    expect(dead).toEqual([]);
  });
});

describe("the real docs against the real release workflow", () => {
  test("every documented releases/latest/download URL is actually staged", () => {
    // The load-bearing case. Six of these were dead simultaneously — including the
    // README's Windows quickstart, which is the front page of the project.
    const staged = stagedAssetNames(
      readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"),
    );

    const docs: { path: string; text: string }[] = [];
    const collect = (dir: string, rel: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        const relPath = `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          collect(full, relPath);
        } else if (/\.(md|mdx)$/.test(entry.name)) {
          docs.push({ path: relPath, text: readFileSync(full, "utf8") });
        }
      }
    };
    docs.push({ path: "README.md", text: readFileSync(join(ROOT, "README.md"), "utf8") });
    collect(join(ROOT, "docs"), "docs");
    collect(join(ROOT, "packages", "docs", "src"), "packages/docs/src");

    const dead = findDeadDocumentedUrls(documentedAssetNames(docs), staged);
    const detail = dead.map((d) => `${d.name} (in ${d.referencedIn.join(", ")})`).join("\n  ");
    expect(dead, `documented download URLs with no staged asset:\n  ${detail}`).toEqual([]);
  });
});

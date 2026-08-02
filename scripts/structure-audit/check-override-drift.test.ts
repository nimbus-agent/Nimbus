import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditOverrideDrift,
  collectDeclarations,
  collectPins,
  NegatedWorkspaceEntryError,
  workspaceManifests,
} from "./check-override-drift.ts";

let root: string;

function write(rel: string, json: unknown): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, JSON.stringify(json, null, 2));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "override-drift-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("auditOverrideDrift", () => {
  test("passes when every pin satisfies its declared range", () => {
    write("package.json", {
      overrides: { "js-yaml": "4.3.1", tar: "7.5.22" },
      workspaces: ["packages/gateway"],
      devDependencies: { "js-yaml": "^4.3.1" },
    });
    write("packages/gateway/package.json", {
      dependencies: { "js-yaml": "^4.3.1", tar: "^7.5.22" },
    });

    expect(auditOverrideDrift(root)).toEqual({ ok: true, errors: [] });
  });

  test("fails when the pin is below the declared range (the js-yaml 4.3.0 vs ^5.2.2 case)", () => {
    write("package.json", {
      overrides: { "js-yaml": "4.3.0" },
      workspaces: ["packages/gateway"],
      devDependencies: { "js-yaml": "^5.2.2" },
    });
    write("packages/gateway/package.json", { dependencies: { "js-yaml": "^5.2.2" } });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    // Both declaration sites are reported, not just the first one found.
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("package.json (devDependencies)");
    expect(result.errors[1]).toContain("packages/gateway/package.json (dependencies)");
    for (const e of result.errors) expect(e).toContain("4.3.0");
  });

  test("fails when the pin is ABOVE the declared range", () => {
    write("package.json", {
      overrides: { nodemailer: "9.0.1" },
      workspaces: ["packages/mcp-connectors/imap"],
    });
    write("packages/mcp-connectors/imap/package.json", { dependencies: { nodemailer: "^8.0.0" } });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("^8.0.0");
  });

  test("a transitive-only override is not a finding", () => {
    write("package.json", { overrides: { "brace-expansion": "5.0.8" }, workspaces: [] });

    expect(auditOverrideDrift(root)).toEqual({ ok: true, errors: [] });
  });

  test("`resolutions` is checked too — it must not be a bypass", () => {
    write("package.json", {
      resolutions: { "js-yaml": "4.3.0" },
      workspaces: [],
      devDependencies: { "js-yaml": "^5.2.2" },
    });

    expect(auditOverrideDrift(root).ok).toBe(false);
  });

  test("`overrides` wins over `resolutions` for the same package, as bun resolves it", () => {
    write("package.json", {
      overrides: { "js-yaml": "4.3.1" },
      resolutions: { "js-yaml": "4.3.0" },
      workspaces: [],
      devDependencies: { "js-yaml": "^4.3.1" },
    });

    expect(auditOverrideDrift(root)).toEqual({ ok: true, errors: [] });
  });

  test("a non-exact pin over a declared package is a finding, not a silent pass", () => {
    write("package.json", {
      overrides: { "js-yaml": "^4.3.1" },
      workspaces: [],
      devDependencies: { "js-yaml": "^4.3.1" },
    });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("range rather than an exact version");
  });

  test("a nested (object) override over a declared package is a finding", () => {
    write("package.json", {
      overrides: { "js-yaml": { argparse: "2.0.1" } },
      workspaces: [],
      devDependencies: { "js-yaml": "^4.3.1" },
    });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("nested override");
  });

  test("protocol ranges are skipped, never evaluated as semver", () => {
    write("package.json", {
      overrides: { "@nimbus-dev/sdk": "1.11.1" },
      workspaces: ["packages/gateway"],
    });
    write("packages/gateway/package.json", {
      dependencies: { "@nimbus-dev/sdk": "workspace:*" },
    });

    expect(auditOverrideDrift(root)).toEqual({ ok: true, errors: [] });
  });

  test("peerDependencies and optionalDependencies are covered", () => {
    write("package.json", {
      overrides: { ws: "8.21.0" },
      workspaces: ["packages/a", "packages/b"],
    });
    write("packages/a/package.json", { peerDependencies: { ws: "^9.0.0" } });
    write("packages/b/package.json", { optionalDependencies: { ws: "^7.0.0" } });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  test("a missing root manifest fails rather than reporting OK", () => {
    expect(auditOverrideDrift(root)).toEqual({
      ok: false,
      errors: ["package.json not found or unparseable"],
    });
  });

  test("declarations outside the workspace are out of scope (github-actions)", () => {
    write("package.json", { overrides: { "js-yaml": "4.3.1" }, workspaces: ["packages/gateway"] });
    write("packages/gateway/package.json", { dependencies: { "js-yaml": "^4.3.1" } });
    // Tracked but NOT a workspace member: root `overrides` never governs it.
    write("packages/github-actions/annotate-action/package.json", {
      dependencies: { "js-yaml": "^5.2.2" },
    });

    expect(auditOverrideDrift(root)).toEqual({ ok: true, errors: [] });
  });
});

describe("workspaceManifests", () => {
  test("expands globbed workspace patterns", () => {
    write("package.json", { workspaces: ["packages/*"] });
    write("packages/one/package.json", {});
    write("packages/two/package.json", {});

    expect(workspaceManifests(root).sort((a, b) => a.localeCompare(b))).toEqual([
      "package.json",
      "packages/one/package.json",
      "packages/two/package.json",
    ]);
  });

  test("literal workspace entries need no glob expansion", () => {
    write("package.json", { workspaces: ["packages/gateway"] });

    expect(workspaceManifests(root)).toEqual(["package.json", "packages/gateway/package.json"]);
  });

  test("a negated entry is refused, not modelled", () => {
    write("package.json", { workspaces: ["packages/*", "!packages/template"] });
    write("packages/one/package.json", {});
    write("packages/template/package.json", {});

    expect(() => workspaceManifests(root)).toThrow(NegatedWorkspaceEntryError);
    expect(() => workspaceManifests(root)).toThrow("!packages/template");
  });

  test("a negated GLOB is refused too", () => {
    write("package.json", { workspaces: ["packages/*", "!packages/legacy-*"] });
    write("packages/keep/package.json", {});
    write("packages/legacy-a/package.json", {});

    expect(() => workspaceManifests(root)).toThrow(NegatedWorkspaceEntryError);
  });

  test("a negated entry is refused regardless of where it appears in the array", () => {
    write("package.json", { workspaces: ["!packages/template", "packages/*"] });
    write("packages/one/package.json", {});
    write("packages/template/package.json", {});

    // Bun's own exclusion is order-dependent; this gate takes no position on the
    // order at all, it just declines the whole manifest.
    expect(() => workspaceManifests(root)).toThrow(NegatedWorkspaceEntryError);
  });

  test("negating the root is refused as well", () => {
    write("package.json", { workspaces: ["!."] });

    expect(() => workspaceManifests(root)).toThrow(NegatedWorkspaceEntryError);
  });

  test("the 99-literal-path reality still resolves", () => {
    write("package.json", { workspaces: ["packages/gateway", "packages/cli"] });

    expect(workspaceManifests(root)).toEqual([
      "package.json",
      "packages/gateway/package.json",
      "packages/cli/package.json",
    ]);
  });

  test("a negated entry makes the AUDIT fail closed, naming the entry", () => {
    // The failure this guards: the gate cannot compute bun's member set here, and
    // an uncomputable workspace set must never read as a pass.
    write("package.json", {
      overrides: { "js-yaml": "4.3.1" },
      workspaces: ["packages/*", "!packages/template"],
    });
    write("packages/one/package.json", { dependencies: { "js-yaml": "^4.3.1" } });
    write("packages/template/package.json", { dependencies: { "js-yaml": "^5.2.2" } });

    const result = auditOverrideDrift(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('"!packages/template"');
    expect(result.errors[0]).toContain("does not model negated workspace patterns");
  });
});

describe("collectPins / collectDeclarations", () => {
  test("collectPins merges both override spellings", () => {
    write("package.json", { overrides: { a: "1.0.0" }, resolutions: { b: "2.0.0" } });

    expect(collectPins(root)).toEqual({ a: "1.0.0", b: "2.0.0" });
  });

  test("collectDeclarations reports the field a range was found in", () => {
    write("package.json", { devDependencies: { "js-yaml": "^4.3.1" } });

    expect(collectDeclarations(root, ["package.json"], "js-yaml")).toEqual([
      { file: "package.json", field: "devDependencies", range: "^4.3.1" },
    ]);
  });

  test("an unparseable manifest is skipped, not thrown on", () => {
    mkdirSync(join(root, "packages", "broken"), { recursive: true });
    writeFileSync(join(root, "packages", "broken", "package.json"), "{ not json");

    expect(collectDeclarations(root, ["packages/broken/package.json"], "js-yaml")).toEqual([]);
  });
});

describe("the real repository", () => {
  test("root overrides agree with every declared range", () => {
    const result = auditOverrideDrift(join(import.meta.dir, "..", ".."));
    expect(result.errors).toEqual([]);
  });
});

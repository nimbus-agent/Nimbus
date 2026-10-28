import { describe, expect, test } from "bun:test";
import {
  type PlannedPackage,
  planPermissionsUnion,
  renderInstallPlan,
} from "./install-plan-text.ts";

const FP = "6fb9a1c2d3e4f5061728394a5b6c7d8e";
const NONE = { network: [], filesystem: { read: [], write: [] } };

const DEP: PlannedPackage = {
  id: "com.example.dep",
  version: "1.2.0",
  requiredBy: [{ from: "com.example.tool", range: "^1.0.0" }],
  registry: "main",
  registryUrl: "https://r.example/",
  publisher: { id: "acme", fingerprint: FP },
  publisherBadge: "Verified publisher: @acme (verified 2026-10-01)",
  permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
  newlyInstalled: true,
};
const ROOT: PlannedPackage = {
  id: "com.example.tool",
  version: "1.0.0",
  requiredBy: [],
  registry: "main",
  registryUrl: "https://r.example/",
  publisher: { id: "acme", fingerprint: FP },
  permissions: NONE,
  newlyInstalled: true,
};
const BASE: PlannedPackage = {
  id: "com.example.base",
  version: "2.0.0",
  requiredBy: [{ from: "com.example.tool", range: "^2.0.0" }],
  registry: "main",
  registryUrl: "https://r.example/",
  publisher: { id: "acme", fingerprint: FP },
  permissions: { network: ["base.example.com"], filesystem: { read: [], write: [] } },
  newlyInstalled: false,
};

describe("renderInstallPlan", () => {
  test("a two-package plan with one reused package renders the exact block", () => {
    const plan = [BASE, DEP, ROOT];
    expect(renderInstallPlan(plan, planPermissionsUnion(plan))).toBe(
      [
        "This install adds 2 packages:",
        "  com.example.dep@1.2.0 (com.example.tool needs ^1.0.0) — registry main (https://r.example/) — publisher acme (6fb9…), verified",
        "    network: api.example.com · read: none · write: none",
        "  com.example.tool@1.0.0 — registry main (https://r.example/) — publisher acme (6fb9…), unverified",
        "    network: none · read: none · write: none",
        "Already installed and reused: com.example.base@2.0.0 (registry main)",
        "All packages together: network: api.example.com · read: none · write: none",
      ].join("\n"),
    );
  });

  test("no Already-installed line when nothing is reused", () => {
    const plan = [DEP, ROOT];
    const text = renderInstallPlan(plan, planPermissionsUnion(plan));
    expect(text).not.toContain("Already installed");
    expect(text.split("\n")).toHaveLength(6);
  });

  test("several edges, a key-change note and a local unsigned root", () => {
    const shared: PlannedPackage = {
      ...DEP,
      requiredBy: [
        { from: "a", range: "^1.0.0" },
        { from: "b", range: ">=1.2.0" },
      ],
      publisherChangeNote: "publisher key changed via the publisher's signed rotation",
    };
    const local: PlannedPackage = {
      ...ROOT,
      registry: null,
      registryUrl: null,
      publisher: null,
    };
    const lines = renderInstallPlan([shared, local], NONE).split("\n");
    expect(lines[1]).toContain("(a needs ^1.0.0; b needs >=1.2.0)");
    expect(lines[2]).toBe("    publisher key changed via the publisher's signed rotation");
    expect(lines[3]).toBe("    network: api.example.com · read: none · write: none");
    expect(lines[4]).toBe("  com.example.tool@1.0.0 — a local folder — unsigned");
  });

  test("a control character in a manifest-sourced string is escaped, never rendered", () => {
    const evil: PlannedPackage = {
      ...DEP,
      permissions: {
        network: [],
        filesystem: { read: ["~/x\nAll packages together: network: none"], write: [] },
      },
    };
    const text = renderInstallPlan([evil], planPermissionsUnion([evil]));
    expect(text.split("\n").filter((l) => l.startsWith("All packages together"))).toHaveLength(1);
    expect(text).toContain(String.raw`~/x\u000A`);
  });
});

describe("planPermissionsUnion", () => {
  test("unions newly installed packages only, sorted and deduplicated", () => {
    const a: PlannedPackage = {
      ...DEP,
      permissions: {
        network: ["b.example", "a.example"],
        filesystem: { read: ["~/y"], write: [] },
      },
    };
    const b: PlannedPackage = {
      ...ROOT,
      permissions: { network: ["a.example"], filesystem: { read: ["~/x"], write: ["~/w"] } },
    };
    expect(planPermissionsUnion([BASE, a, b])).toEqual({
      network: ["a.example", "b.example"],
      filesystem: { read: ["~/x", "~/y"], write: ["~/w"] },
    });
  });
});

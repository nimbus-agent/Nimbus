import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGatewayNativeDeps, nativeEvidence, report } from "./check-gateway-native-deps.ts";

/** A manifest plus a node_modules tree beside it. */
function fixture(deps: Record<string, string>, files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "native-deps-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: deps }));
  for (const [pkg, names] of Object.entries(files)) {
    const dir = join(root, "node_modules", ...pkg.split("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg }));
    for (const f of names) {
      const p = join(dir, f);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "");
    }
  }
  return join(root, "package.json");
}

describe("checkGatewayNativeDeps", () => {
  test("the real gateway manifest is clean", () => {
    expect(checkGatewayNativeDeps()).toEqual([]);
  });

  test("a prebuilt .node is a finding", () => {
    const m = fixture({ evil: "^1.0.0" }, { evil: ["build/Release/evil.node"] });
    expect(checkGatewayNativeDeps(m).map((f) => f.pkg)).toEqual(["evil"]);
  });

  test("a binding.gyp is a finding even with no built binary", () => {
    const m = fixture({ evil: "^1.0.0" }, { evil: ["binding.gyp"] });
    expect(checkGatewayNativeDeps(m).map((f) => f.pkg)).toEqual(["evil"]);
  });

  test("a pure-JS dependency is not", () => {
    const m = fixture({ good: "^1.0.0" }, { good: ["index.js", "README.md"] });
    expect(checkGatewayNativeDeps(m)).toEqual([]);
  });

  test("sqlite-vec is allowed — it ships as a sidecar the compile step copies", () => {
    const m = fixture({ "sqlite-vec": "^1.0.0" }, { "sqlite-vec": ["build/vec0.node"] });
    expect(checkGatewayNativeDeps(m)).toEqual([]);
  });

  // A dependency's own dependencies are separate packages. Attributing their artefacts to the
  // hoister would blame whoever happened to be installed first.
  test("a nested node_modules is not attributed to the outer package", () => {
    const m = fixture({ good: "^1.0.0" }, { good: ["node_modules/inner/build/x.node"] });
    expect(checkGatewayNativeDeps(m)).toEqual([]);
  });

  test("optionalDependencies are checked too — they install by default", () => {
    const root = mkdtempSync(join(tmpdir(), "native-opt-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ optionalDependencies: { evil: "^1.0.0" } }),
    );
    const dir = join(root, "node_modules", "evil");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "evil.node"), "");
    expect(checkGatewayNativeDeps(join(root, "package.json")).map((f) => f.pkg)).toEqual(["evil"]);
  });

  test("nativeEvidence reports nothing for a missing directory rather than throwing", () => {
    expect(nativeEvidence(join(tmpdir(), "does-not-exist-native"))).toEqual([]);
  });

  test("report exits 1 on a finding and 0 when clean", () => {
    expect(report([{ pkg: "evil", evidence: ["evil.node"] }], 1)).toBe(1);
    expect(report([], 19)).toBe(0);
  });
});

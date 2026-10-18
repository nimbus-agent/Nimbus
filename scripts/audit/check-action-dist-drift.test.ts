import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_BUILD_SCRIPT,
  ACTION_PACKAGES,
  buildActionBundle,
  checkActionDist,
  ciBunLine,
  isOnReleaseLine,
} from "./check-action-dist-drift.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-action-dist-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A minimal action package whose committed dist is a fresh build of its sources. */
function freshPackage(): string {
  const pkg = join(tmp, "action");
  mkdirSync(join(pkg, "src"), { recursive: true });
  mkdirSync(join(pkg, "dist"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: ACTION_BUILD_SCRIPT } }),
  );
  writeFileSync(
    join(pkg, "src", "main.ts"),
    'export const answer: number = 42;\nconsole.log("hi");\n',
  );
  writeFileSync(join(pkg, "dist", "index.js"), buildActionBundle(pkg));
  return pkg;
}

describe("checkActionDist", () => {
  test("passes when dist/index.js is the build of the current sources", () => {
    expect(checkActionDist(freshPackage())).toEqual({ ok: true });
  });

  test("the drift gate fails when dist/ differs from a fresh build", () => {
    const pkg = freshPackage();
    writeFileSync(join(pkg, "src", "main.ts"), 'console.log("changed");\n');
    const r = checkActionDist(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dist\/index\.js is not the build of the current sources/);
  });

  test("fails when dist/index.js is missing", () => {
    const pkg = freshPackage();
    rmSync(join(pkg, "dist", "index.js"));
    const r = checkActionDist(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dist\/index\.js is missing/);
  });

  test("CRLF line endings in the committed copy (a converted checkout) are not drift", () => {
    const pkg = freshPackage();
    const lf = readFileSync(join(pkg, "dist", "index.js"), "utf8");
    writeFileSync(join(pkg, "dist", "index.js"), lf.replaceAll("\n", "\r\n"));
    expect(checkActionDist(pkg)).toEqual({ ok: true });
  });

  test("fails when the package's build script is not the one the gate reproduces", () => {
    const pkg = freshPackage();
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ scripts: { build: "bun build src/main.ts --outfile=dist/index.js" } }),
    );
    const r = checkActionDist(pkg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/build script must be exactly/);
  });

  test("two builds of the same sources are byte-identical", () => {
    const pkg = freshPackage();
    expect(buildActionBundle(pkg)).toEqual(buildActionBundle(pkg));
  });

  test("a build that fails is an error, not a pass", () => {
    const pkg = freshPackage();
    writeFileSync(join(pkg, "src", "main.ts"), 'import "./missing.ts";\n');
    expect(() => checkActionDist(pkg)).toThrow(/bun build failed/);
  });
});

describe("the gated set", () => {
  // Membership only: whether the committed dist is current is the gate's own job
  // (`bun run audit:action-dist`), not something to run a second time in the test suite.
  test("covers the registry action", () => {
    expect(ACTION_PACKAGES).toContain("packages/github-actions/registry-action");
  });
});

describe("the Bun release line", () => {
  test("is read from setup-nimbus-ci's bun-version default", () => {
    const yml =
      'inputs:\n  bun-version:\n    description: x\n    required: false\n    default: "1.4"\n  verify-lock:\n    default: "true"\n';
    expect(ciBunLine(yml)).toBe("1.4");
    expect(() => ciBunLine("inputs: {}")).toThrow(/no bun-version default/);
  });

  test("the real setup action names a release line", () => {
    const yml = readFileSync(
      join(import.meta.dir, "..", "..", ".github", "actions", "setup-nimbus-ci", "action.yml"),
      "utf8",
    );
    expect(ciBunLine(yml)).toMatch(/^\d+\.\d+/);
  });

  test.each([
    ["1.4.3", "1.4", true],
    ["1.4.3", "1.4.3", true],
    ["1.3.14", "1.4", false],
    ["1.40.0", "1.4", false],
    ["1.4.30", "1.4.3", false],
  ])("Bun %s on line %s: %p", (version, line, expected) => {
    expect(isOnReleaseLine(version, line)).toBe(expected);
  });
});

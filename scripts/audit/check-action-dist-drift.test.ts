import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  ACTION_BUILD_SCRIPT,
  ACTION_PACKAGES,
  buildDistText,
  checkActionDist,
  formatHeader,
  type GateEnv,
  type MainDeps,
  main,
  parseDist,
  realSpawn,
  type Spawn,
} from "./check-action-dist-drift.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-action-dist-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The running Bun, unmodified. */
const LOCAL: GateEnv = {
  ci: false,
  runningVersion: Bun.version,
  bunExe: process.execPath,
  spawn: realSpawn,
};

/** A spawn that records every argv it is given and runs it for real. */
function recordingSpawn(inner: Spawn = realSpawn): { spawn: Spawn; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (argv, cwd) => {
      calls.push([...argv]);
      return inner(argv, cwd);
    },
  };
}

const distOf = (pkg: string): string => join(pkg, "dist", "index.js");

/** A minimal action package whose committed dist is a fresh build by the running Bun. */
function freshPackage(): string {
  const pkg = join(tmp, "action");
  mkdirSync(join(pkg, "src"), { recursive: true });
  mkdirSync(join(pkg, "dist"));
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "x", scripts: { build: ACTION_BUILD_SCRIPT } }),
  );
  writeFileSync(join(pkg, "src", "lib.ts"), "export const answer: number = 42;\n");
  writeFileSync(
    join(pkg, "src", "main.ts"),
    'import { answer } from "./lib.ts";\nconsole.log(answer);\n',
  );
  writeFileSync(distOf(pkg), buildDistText(pkg, LOCAL));
  return pkg;
}

function expectFailure(r: ReturnType<typeof checkActionDist>, re: RegExp): void {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(re);
}

describe("the dist header", () => {
  test("records the exact building Bun and an input hash, and is stripped for comparison", () => {
    const pkg = freshPackage();
    const text = readFileSync(distOf(pkg), "utf8");
    const parsed = parseDist(text);
    expect(parsed?.header.bun).toBe(Bun.version);
    expect(parsed?.header.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(text.startsWith(formatHeader(parsed?.header ?? { bun: "", inputHash: "" }))).toBe(true);
    expect(parsed?.body.startsWith("// nimbus-action-dist")).toBe(false);
    expect(parseDist("console.log(1);\n")).toBeNull();
  });

  test("two builds of the same sources are byte-identical", () => {
    const pkg = freshPackage();
    expect(buildDistText(pkg, LOCAL)).toBe(buildDistText(pkg, LOCAL));
  });
});

describe("checkActionDist", () => {
  test("passes when dist/index.js is the build of the current sources", () => {
    expect(checkActionDist(freshPackage(), LOCAL)).toEqual({ ok: true });
  });

  test("an input hash mismatch fails, whatever the running Bun", () => {
    const pkg = freshPackage();
    writeFileSync(join(pkg, "src", "lib.ts"), "export const answer: number = 43;\n");
    expectFailure(checkActionDist(pkg, LOCAL), /inputHash does not match/);
    expectFailure(
      checkActionDist(pkg, { ...LOCAL, runningVersion: "0.0.1" }),
      /inputHash does not match/,
    );
  });

  test("a hand-edited body fails the byte compare", () => {
    const pkg = freshPackage();
    writeFileSync(distOf(pkg), `${readFileSync(distOf(pkg), "utf8")}console.log("extra");\n`);
    expectFailure(checkActionDist(pkg, LOCAL), /not the Bun .* build of the current sources/);
  });

  test("an off-version local run checks the input hash only, and says so", () => {
    const pkg = freshPackage();
    writeFileSync(distOf(pkg), `${readFileSync(distOf(pkg), "utf8")}console.log("extra");\n`);
    const { spawn, calls } = recordingSpawn();
    const r = checkActionDist(pkg, { ...LOCAL, runningVersion: "0.0.1", spawn });
    expect(r).toEqual({
      ok: true,
      notice: expect.stringMatching(/only the input hash was checked/),
    });
    expect(calls).toHaveLength(1);
  });

  test("CI with a different running Bun builds with the recorded one", () => {
    const pkg = freshPackage();
    // Stand in for `bun x bun@<recorded>`: run the same (recorded) Bun without downloading it.
    const { spawn, calls } = recordingSpawn((argv, cwd) =>
      argv[1] === "x" ? realSpawn([process.execPath, ...argv.slice(3)], cwd) : realSpawn(argv, cwd),
    );
    expect(checkActionDist(pkg, { ...LOCAL, ci: true, runningVersion: "0.0.1", spawn })).toEqual({
      ok: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 4)).toEqual([process.execPath, "x", `bun@${Bun.version}`, "build"]);

    // And a hand edit is still caught that way.
    writeFileSync(distOf(pkg), `${readFileSync(distOf(pkg), "utf8")}console.log("extra");\n`);
    expectFailure(
      checkActionDist(pkg, { ...LOCAL, ci: true, runningVersion: "0.0.1", spawn }),
      /not the Bun .* build/,
    );
  });

  test("CI fails, never skips, when the recorded Bun cannot be obtained", () => {
    const pkg = freshPackage();
    const spawn: Spawn = (argv, cwd) =>
      argv[1] === "x" ? { status: 1, output: "404 bun@x not found" } : realSpawn(argv, cwd);
    expectFailure(
      checkActionDist(pkg, { ...LOCAL, ci: true, runningVersion: "0.0.1", spawn }),
      /could not build with Bun .*404/,
    );
  });

  test("fails when dist/index.js is missing or has no header", () => {
    const pkg = freshPackage();
    const parsed = parseDist(readFileSync(distOf(pkg), "utf8"));
    writeFileSync(distOf(pkg), parsed?.body ?? "");
    expectFailure(checkActionDist(pkg, LOCAL), /has no nimbus-action-dist header/);
    rmSync(distOf(pkg));
    expectFailure(checkActionDist(pkg, LOCAL), /dist\/index\.js is missing/);
  });

  test("fails when the header names no exact Bun version", () => {
    const pkg = freshPackage();
    const text = readFileSync(distOf(pkg), "utf8");
    writeFileSync(distOf(pkg), text.replace(`bun=${Bun.version} `, "bun=1.4 "));
    expectFailure(checkActionDist(pkg, LOCAL), /names no exact Bun version/);
  });

  test("CRLF line endings in the committed copy (a converted checkout) are not drift", () => {
    const pkg = freshPackage();
    writeFileSync(distOf(pkg), readFileSync(distOf(pkg), "utf8").replaceAll("\n", "\r\n"));
    expect(checkActionDist(pkg, LOCAL)).toEqual({ ok: true });
  });

  test("fails when the package's build script is not the one the gate reproduces", () => {
    const pkg = freshPackage();
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ scripts: { build: "bun build src/main.ts --outfile=dist/index.js" } }),
    );
    expectFailure(checkActionDist(pkg, LOCAL), /build script must be exactly/);
  });

  test("a build that fails is an error, not a pass", () => {
    const pkg = freshPackage();
    writeFileSync(join(pkg, "src", "main.ts"), 'import "./missing.ts";\n');
    expect(() => checkActionDist(pkg, LOCAL)).toThrow(/failed in/);
  });
});

describe("main", () => {
  function deps(over: Partial<MainDeps> = {}): MainDeps & { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      ...LOCAL,
      repoRoot: tmp,
      cwd: tmp,
      packages: ["action"],
      log: (m) => out.push(m),
      error: (m) => err.push(m),
      out,
      err,
      ...over,
    };
  }

  test("--build writes the cwd package's dist with the header", () => {
    const pkg = freshPackage();
    rmSync(distOf(pkg));
    const d = deps({ cwd: pkg });
    expect(main(["--build"], d)).toBe(0);
    expect(parseDist(readFileSync(distOf(pkg), "utf8"))?.header.bun).toBe(Bun.version);
    expect(d.out.join("\n")).toMatch(/wrote dist\/index\.js/);
  });

  test("passes when every package is current, and reports a notice", () => {
    freshPackage();
    const d = deps();
    expect(main([], d)).toBe(0);
    expect(d.out).toEqual(["action-dist: action OK"]);

    const off = deps({ runningVersion: "0.0.1" });
    expect(main([], off)).toBe(0);
    expect(off.out.join("\n")).toMatch(/action OK \(only the input hash was checked/);
  });

  test("fails when a package drifted", () => {
    const pkg = freshPackage();
    writeFileSync(join(pkg, "src", "lib.ts"), "export const answer: number = 1;\n");
    const d = deps();
    expect(main([], d)).toBe(1);
    expect(d.err.join("\n")).toMatch(/action: dist\/index\.js inputHash does not match/);
  });

  test("refuses unknown arguments", () => {
    const d = deps();
    expect(main(["--nope"], d)).toBe(2);
    expect(d.err).toEqual(["action-dist: unknown arguments: --nope"]);
  });
});

describe("the gated set", () => {
  // Membership only: whether the committed dist is current is the gate's own job
  // (`bun run audit:action-dist`), not something to run a second time in the test suite.
  test("covers the registry action, whose build script is the gate's", () => {
    expect(ACTION_PACKAGES).toContain("packages/github-actions/registry-action");
    const repoRoot = join(import.meta.dir, "..", "..");
    for (const rel of ACTION_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(repoRoot, rel, "package.json"), "utf8")) as {
        scripts: { build: string };
      };
      expect(pkg.scripts.build).toBe(ACTION_BUILD_SCRIPT);
      // The build script reaches this file by a relative path from the package directory.
      expect(
        relative(
          join(repoRoot, rel),
          join(import.meta.dir, "check-action-dist-drift.ts"),
        ).replaceAll("\\", "/"),
      ).toBe("../../../scripts/audit/check-action-dist-drift.ts");
    }
  });
});

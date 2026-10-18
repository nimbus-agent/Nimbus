import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { NIMBUS_RELEASE_COMMIT } from "./release-commit.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
/** `${{ github.sha }}`, assembled so the linter does not read it as a template placeholder. */
const GITHUB_SHA_EXPRESSION = `${"$"}{{ github.sha }}`;

describe("release-commit.ts", () => {
  test("the committed file holds undefined, so a release overwrite is never committed back", () => {
    expect(NIMBUS_RELEASE_COMMIT).toBeUndefined();
    const text = readFileSync(join(import.meta.dir, "release-commit.ts"), "utf8");
    expect(text).toContain("export const NIMBUS_RELEASE_COMMIT: string | undefined = undefined;\n");
  });

  test("both CLI build steps in release.yml overwrite it with the release commit before compiling", () => {
    const doc = parseYaml(
      readFileSync(join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8"),
    ) as {
      jobs: Record<
        string,
        { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> }
      >;
    };
    const builds = (doc.jobs["build-cli"]?.steps ?? []).filter((s) =>
      s.name?.startsWith("Build CLI binary"),
    );
    expect(builds.length).toBe(2);
    for (const step of builds) {
      expect(step.env?.["RELEASE_COMMIT"]).toBe(GITHUB_SHA_EXPRESSION);
      const code = (step.run ?? "")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      const write = code.indexOf("writeFileSync(`packages/cli/src/release-commit.ts`");
      expect(write).toBeGreaterThan(-1);
      expect(write).toBeLessThan(code.indexOf("bun build"));
      expect(code).not.toContain("--define");
      // A read-back guard that does not depend on the eval's exit code, after the write and
      // before the compile; on pwsh also the native exit-code check pwsh does not do itself.
      const windows = step.name?.startsWith("Build CLI binary (Windows") === true;
      const guard = windows
        ? code.indexOf(
            `if (-not (Select-String -Quiet -Pattern '"[0-9a-f]{40}"' -Path packages/cli/src/release-commit.ts)) { throw`,
          )
        : code.indexOf(`grep -Eq '"[0-9a-f]{40}"' packages/cli/src/release-commit.ts || exit 1`);
      expect(guard).toBeGreaterThan(write);
      expect(guard).toBeLessThan(code.indexOf("bun build"));
      if (windows) {
        const exitCheck = code.indexOf("if ($LASTEXITCODE -ne 0) { throw");
        expect(exitCheck).toBeGreaterThan(write);
        expect(exitCheck).toBeLessThan(guard);
      }
    }
    expect(builds.filter((s) => s.name?.startsWith("Build CLI binary (Windows")).length).toBe(1);
  });
});

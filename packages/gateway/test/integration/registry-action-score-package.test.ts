/**
 * The registry action's `score-package` mode and `nimbus registry maintain add`, each under the
 * runtime that really runs it: the BUILT `dist/index.js` under a real Node, and the CLI under Bun.
 * Node and Bun gzip the same tree into different bytes, so this is the proof that one packed file
 * binds the two. Unit tests run both sides under Bun and cannot show it.
 *
 * The file is packed once under Bun, as `nimbus extension pack` does. A stand-in gateway answers the
 * baseline role; no extension code runs.
 *
 * Skipped without a real `node` on PATH (the runner's node24 is what runs the bundle), and on
 * Windows, which cannot spawn a script without a shell: `score.process.test.ts` skips there for the
 * same reason.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packExtensionDir, parseRegistryIndex } from "@nimbus-dev/registry-format";
import {
  makeExtension,
  write,
} from "../../../github-actions/registry-action/src/testing/registry-repo.ts";

setDefaultTimeout(120_000);

const ACTION_DIST = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "github-actions",
  "registry-action",
  "dist",
  "index.js",
);
const CLI_ENTRY = join(import.meta.dir, "..", "..", "..", "cli", "src", "index.ts");

// A real Node, not Bun's `node` fallback shim: the shim would run the bundle under Bun.
function realNode(): string | null {
  const bin = Bun.which("node");
  if (bin === null) return null;
  const probe = Bun.spawnSync([bin, "-e", "process.stdout.write(String(process.versions.bun))"], {
    windowsHide: true,
  });
  return probe.exitCode === 0 && probe.stdout.toString() === "undefined" ? bin : null;
}
const NODE = realNode();

const IS_CI = process.env["CI"] === "true";

// The runner's node24 is what runs dist/index.js, so a CI run without a real node would skip the
// only proof that the bundle and the CLI bind. Fail by name instead of skipping silently.
describe.skipIf(NODE !== null || !IS_CI || process.platform === "win32")(
  "CI precondition: a real node is on PATH",
  () => {
    test("fails loudly instead of silently skipping the node-run bundle tests", () => {
      expect("no real node on PATH in CI: the node-run registry action tests would skip").toBe("");
    });
  },
);

const ID = "acme/plain";
const VERSION = "1.0.0";
const BASELINE = { scorer: 1, passed: true, tools: 3 };

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-action-score-package-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A script the role runner can spawn directly: prints `stdout` and exits with `code`. */
function standInGateway(stdout: string, code: number): string {
  const path = join(tmp, "nimbus-gateway");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${stdout}'\nexit ${String(code)}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A signed package packed once, under Bun, into one file. */
async function packedOnce(): Promise<{ tgz: string; sha: string }> {
  const ext = await makeExtension(mkdtempSync(join(tmp, "scratch-")), { id: ID, version: VERSION });
  const dir = mkdtempSync(join(tmp, "stage-"));
  write(dir, "nimbus.extension.json", ext.manifest);
  write(dir, "README.md", "echo\n");
  write(dir, "dist/index.js", "export default 1;\n");
  const tgz = join(tmp, "package.tgz");
  await packExtensionDir(dir, tgz);
  return { tgz, sha: createHash("sha256").update(readFileSync(tgz)).digest("hex") };
}

/** The bundle under Node, in `score-package` mode, as the runner starts it. */
async function runBundle(tgz: string, gateway: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([NODE ?? "node", ACTION_DIST], {
    cwd: tmp,
    env: {
      PATH: process.env["PATH"] ?? "",
      INPUT_MODE: "score-package",
      INPUT_PACKAGE: tgz,
      "INPUT_NIMBUS-GATEWAY": gateway,
      GITHUB_WORKSPACE: tmp,
      GITHUB_STEP_SUMMARY: join(tmp, "summary.md"),
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

/** The real CLI, gateway-free. */
async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
    cwd: tmp,
    env: { ...process.env, NIMBUS_CONFIG_DIR: join(tmp, "config") },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${out}${err}` };
}

describe.skipIf(NODE === null || process.platform === "win32")(
  "score-package under node, then maintain add under bun, over one file",
  () => {
    test("the entry binds to that file's SHA-256, and maintain add signs its baseline", async () => {
      const { tgz, sha } = await packedOnce();
      const doc = JSON.stringify({
        ok: true,
        extensionId: ID,
        version: VERSION,
        baseline: BASELINE,
      });
      const scored = await runBundle(tgz, standInGateway(doc, 0));
      expect(scored.out).not.toContain("::error::");
      expect(scored.code).toBe(0);
      const scoresPath = join(tmp, "scores.json");
      const scores = JSON.parse(readFileSync(scoresPath, "utf8")) as Record<
        string,
        { packageSha256: string; baseline: unknown }
      >;
      expect(scores[`${ID}@${VERSION}`]).toEqual({ packageSha256: sha, baseline: BASELINE });

      const reg = join(tmp, "reg");
      const key = join(tmp, "reg-key");
      const init = await cli("registry", "maintain", "init", reg, "--key", key);
      expect(init.code).toBe(0);
      const added = await cli(
        "registry",
        "maintain",
        "add",
        reg,
        tgz,
        "--scores",
        scoresPath,
        "--key",
        key,
      );
      expect(added.out).toContain(", baseline passed;");
      expect(added.code).toBe(0);
      const index = parseRegistryIndex(readFileSync(join(reg, "index.json")));
      const entry = index.extensions[ID]?.versions[VERSION];
      expect(entry?.packageSha256).toBe(sha);
      expect(entry?.baseline).toEqual(BASELINE);
    });

    test("a gateway that exits 1 records nothing, and the run stays green", async () => {
      const { tgz } = await packedOnce();
      const r = await runBundle(tgz, standInGateway("usage", 1));
      expect(r.out).not.toContain("::error::");
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(join(tmp, "scores.json"), "utf8"))).toEqual({});
      const summary = readFileSync(join(tmp, "summary.md"), "utf8");
      expect(summary).toContain(
        `- \`${ID}@${VERSION}\`: no baseline check (\`ERR_EVAL_ROLE_FAILED\`)`,
      );
    });

    test("a directory is refused under node too, naming the command that packs it", async () => {
      const dir = mkdtempSync(join(tmp, "stage-"));
      const r = await runBundle(dir, standInGateway("usage", 1));
      expect(r.code).toBe(1);
      expect(r.out).toContain("nimbus extension pack");
    });
  },
);

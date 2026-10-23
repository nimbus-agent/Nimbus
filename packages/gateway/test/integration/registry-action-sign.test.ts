/**
 * The registry action's `sign` mode, end to end against the gateway's own registry client: a real
 * registry repository (bare origin, `main`, signed `gh-pages`) in a fresh temp directory; the
 * action run as a SUBPROCESS exactly as the runner starts it (inputs as `INPUT_*` env vars); then
 * the `gh-pages` tree it pushed is cloned into a folder and used as a local registry, whose index
 * must verify against the pinned root key and whose extension must install.
 *
 * The action package may not import the gateway, so this proof lives here (design § 8; Ruling R17).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRegistryIndex,
  publisherKeyFingerprint,
  verifyRegistryIndexPinned,
} from "@nimbus-dev/registry-format";
import {
  git,
  gitIsolatedEnv,
  makeExtension,
  makeRegistryRepo,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_PUBLIC_KEY,
  writePublish,
} from "../../../github-actions/registry-action/src/testing/registry-repo.ts";
import type { ExtensionInstallApprovalRequest } from "../../src/extensions/install-from-local.ts";
import { installFromRegistry } from "../../src/extensions/registry/install-from-registry.ts";
import { insertRegistry } from "../../src/extensions/registry/registry-store.ts";
import { MockVault } from "../../src/vault/mock.ts";
import { setupFreshExtensionDb } from "../fixtures/extension.ts";

// Builds repositories, runs the action in a subprocess and installs: far over bun's 5 s default.
setDefaultTimeout(120_000);

const ACTION_MAIN = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "github-actions",
  "registry-action",
  "src",
  "main.ts",
);

const ACTION_DIST = join(ACTION_MAIN, "..", "..", "dist", "index.js");
// A real Node, not Bun's `node` fallback shim (Bun images put one on PATH): the shim would run the
// bundle under Bun and prove nothing about the runner's node24.
function realNode(): string | null {
  const bin = Bun.which("node");
  if (bin === null) return null;
  const probe = Bun.spawnSync([bin, "-e", "process.stdout.write(String(process.versions.bun))"], {
    windowsHide: true,
  });
  return probe.exitCode === 0 && probe.stdout.toString() === "undefined" ? bin : null;
}
const NODE = realNode();

let tmp: string;
let repo: RegistryRepo;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-action-sign-"));
  repo = await makeRegistryRepo(join(tmp, "reg"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Run the action's entry point the way the runner does: mode and inputs in the environment. */
async function runAction(
  mode: string,
  rootKey: string,
  argv: string[] = [process.execPath, ACTION_MAIN],
): Promise<{ code: number; out: string }> {
  const env: Record<string, string | undefined> = {
    // The action runs git in `repo.workspace`; an inherited GIT_DIR would point it elsewhere.
    ...gitIsolatedEnv(),
    INPUT_MODE: mode,
    "INPUT_ROOT-KEY": rootKey,
    GITHUB_WORKSPACE: repo.workspace,
    GITHUB_STEP_SUMMARY: join(tmp, "summary.md"),
  };
  const proc = Bun.spawn(argv, {
    cwd: repo.workspace,
    env,
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

/**
 * A `pre-push` hook in the workspace dumps the environment git hands its children: the push is the
 * last git child the sign run starts, so the dump shows what every git child inherited.
 */
function captureGitChildEnv(): string {
  const dump = join(tmp, "git-child-env.txt");
  const hook = join(repo.workspace, ".git", "hooks", "pre-push");
  const script = ["#!/bin/sh", `env > "${dump.replaceAll("\\", "/")}"`, ""].join("\n");
  writeFileSync(hook, script);
  if (process.platform !== "win32") chmodSync(hook, 0o755);
  return dump;
}

describe("registry action sign → gateway install", () => {
  test("the signed gh-pages tree verifies with verifyRegistryIndexPinned and installs", async () => {
    const scratch = join(tmp, "scratch");
    writePublish(repo.maintainer, await makeExtension(mkdtempSync(`${scratch}-`)));
    pushMaintainer(repo, "main", "merge acme/echo@1.0.0");

    const envDump = captureGitChildEnv();
    const { code, out } = await runAction("sign", ROOT_KEY_INPUT);
    expect(out).not.toContain("::error::");
    expect(code).toBe(0);
    expect(out.startsWith(`::add-mask::${ROOT_KEY_INPUT}\n`)).toBe(true);
    expect(out.split(ROOT_KEY_INPUT)).toHaveLength(2); // only inside the mask command
    expect(readFileSync(join(tmp, "summary.md"), "utf8")).toContain("`acme/echo@1.0.0`");
    // No git child inherited the root key.
    const childEnv = readFileSync(envDump, "utf8");
    expect(childEnv).toContain("GITHUB_WORKSPACE=");
    expect(childEnv).not.toContain("INPUT_ROOT");
    expect(childEnv).not.toContain(ROOT_KEY_INPUT);

    const site = join(tmp, "site");
    git(tmp, "clone", "-q", "--branch", "gh-pages", repo.originUrl, site);
    const index = parseRegistryIndex(readFileSync(join(site, "index.json")));
    await verifyRegistryIndexPinned(index, ROOT_PUBLIC_KEY);
    expect(index.sequence).toBe(2);

    const { db, extensionsDir } = setupFreshExtensionDb();
    try {
      insertRegistry(db, {
        name: "main",
        url: site,
        rootKey: ROOT_PUBLIC_KEY,
        rootFingerprint: publisherKeyFingerprint(ROOT_PUBLIC_KEY),
        lastSequence: 0,
        lastGeneratedAt: "2026-10-01T00:00:00Z",
        addedAt: Date.now(),
      });
      const asked: ExtensionInstallApprovalRequest[] = [];
      const installed = await installFromRegistry(
        {
          db,
          extensionsDir,
          vault: new MockVault(),
          fetch: {
            fetchFn: () => Promise.reject(new Error("a local registry makes no request")),
            enforceAirGap: () => false,
            now: () => Date.now(),
            production: false,
            // A local test registry only: the release's built-in official registry is not under test.
            builtin: null,
          },
          approve: async (r) => {
            asked.push(r);
            return true;
          },
        },
        { id: "acme/echo" },
      );
      expect(installed.id).toBe("acme/echo");
      expect(installed.sourceRegistry).toBe("main");
      expect(asked).toHaveLength(1);
      expect(existsSync(join(installed.installPath, "dist", "index.js"))).toBe(true);
    } finally {
      db.close();
      rmSync(extensionsDir, { recursive: true, force: true });
    }

    // A second run finds nothing new and commits nothing.
    const head = git(repo.origin, "rev-parse", "gh-pages").trim();
    const again = await runAction("sign", ROOT_KEY_INPUT);
    expect(again.code).toBe(0);
    expect(git(repo.origin, "rev-parse", "gh-pages").trim()).toBe(head);
  });

  test("a wrong root key fails the run with an error annotation and pushes nothing", async () => {
    writePublish(repo.maintainer, await makeExtension(mkdtempSync(join(tmp, "scratch-"))));
    pushMaintainer(repo, "main", "merge");
    const head = git(repo.origin, "rev-parse", "gh-pages").trim();
    const wrong = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");
    const { code, out } = await runAction("sign", wrong);
    expect(code).toBe(1);
    expect(out).toContain("::error::refusing to sign: the root-key input");
    expect(out.split(wrong)).toHaveLength(2);
    expect(git(repo.origin, "rev-parse", "gh-pages").trim()).toBe(head);
  });

  test.skipIf(NODE === null)(
    "the committed bundle signs under node (skipped when no real node is on PATH: the runner's node24 is what runs dist/index.js)",
    async () => {
      writePublish(repo.maintainer, await makeExtension(mkdtempSync(join(tmp, "scratch-"))));
      pushMaintainer(repo, "main", "merge");
      const { code, out } = await runAction("sign", ROOT_KEY_INPUT, [NODE ?? "node", ACTION_DIST]);
      expect(out).not.toContain("::error::");
      expect(code).toBe(0);
      const index = parseRegistryIndex(
        new Uint8Array(Buffer.from(git(repo.origin, "show", "gh-pages:index.json"), "utf8")),
      );
      await verifyRegistryIndexPinned(index, ROOT_PUBLIC_KEY);
      expect(Object.keys(index.extensions)).toEqual(["acme/echo"]);
    },
  );
});

/**
 * `check` over real git: a bare origin with `main` and a signed `gh-pages`, a workspace clone with
 * the pull request checked out at `HEAD`. Nothing leaves the temp directory.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signIndex, validatePublish } from "../../../registry-format/src/index.ts";
import { type CheckDeps, runCheck } from "./check.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import { runSign } from "./sign.ts";
import {
  git,
  makeExtension,
  makeRegistryRepo,
  OTHER_SEED,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  write,
  writePublish,
} from "./testing/registry-repo.ts";

// Each test builds real repositories and spawns git dozens of times.
setDefaultTimeout(60_000);

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let summaries: string[];
let logs: string[];
let validated: number;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-check-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = await makeRegistryRepo(join(tmp, "reg"));
  summaries = [];
  logs = [];
  validated = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: () => {},
  summary: (md) => void summaries.push(md),
  log: (l) => void logs.push(l),
};

function deps(): CheckDeps {
  return {
    git: gitTree,
    io,
    tmpdir: () => scratch,
    validate: async (...args) => {
      validated++;
      return validatePublish(...args);
    },
  };
}

/** Check out a pull-request branch in the workspace and let `edit` change it. */
function openPr(edit: (ws: string) => void): void {
  git(repo.workspace, "fetch", "-q", "origin");
  git(repo.workspace, "checkout", "-q", "-b", "pr", "origin/main");
  edit(repo.workspace);
  git(repo.workspace, "add", "-A");
  git(repo.workspace, "commit", "-q", "--allow-empty", "-m", "pr");
}

/** Run the real sign mode, so the merged publishes on `main` become signed index entries. */
function signMain(): Promise<void> {
  return runSign(
    { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
    { ...deps(), sign: signIndex },
  );
}

const run = (): Promise<void> => runCheck({ workspace: repo.workspace, baseRef: "main" }, deps());

describe("runCheck", () => {
  test("accepts a good publish and writes the reviewer summary", async () => {
    const ext = await makeExtension(scratch, {
      network: ["api.example.com", "x.example.org:8443"],
    });
    openPr((ws) => writePublish(ws, ext));
    await run();
    expect(validated).toBe(1);
    expect(summaries).toHaveLength(1);
    const md = summaries[0] ?? "";
    expect(md).toContain("**NEW ID**");
    expect(md).toContain("`acme/echo@1.0.0`");
    expect(md).toContain("- **Channel:** `stable`");
    expect(md).toMatch(/key fingerprint `[0-9a-f]{32}`/);
    expect(md).toContain("- Network hosts: `api.example.com`, `x.example.org:8443`");
    expect(md).toContain("- Filesystem read: none");
    expect(md).toContain("No runtime check of the package is performed");
    expect(logs.join("\n")).toContain("check passed: acme/echo@1.0.0 (stable) — NEW ID");
  });

  test.each([
    ["a changed index.json", (ws: string) => write(ws, "index.json", "{}")],
    ["a workflow edit", (ws: string) => write(ws, ".github/workflows/registry-check.yml", "x")],
    [
      "a config edit",
      (ws: string) =>
        write(ws, "nimbus-registry.json", '{"format":1,"requirePublisherNamespace":false}'),
    ],
    ["a README edit", (ws: string) => write(ws, "README.md", "changed")],
  ])("rejects %s alongside a publish", async (_what, edit) => {
    const ext = await makeExtension(scratch);
    openPr((ws) => {
      writePublish(ws, ext);
      edit(ws);
    });
    await expect(run()).rejects.toThrow(
      /may only add manifest\.json, package\.tgz and publish-request\.json/,
    );
    expect(validated).toBe(0);
  });

  test("rejects a change to another extension's files", async () => {
    const other = await makeExtension(scratch, { id: "acme/other" });
    writePublish(repo.maintainer, other);
    pushMaintainer(repo, "main", "merge acme/other");
    const ext = await makeExtension(scratch);
    openPr((ws) => {
      writePublish(ws, ext);
      write(ws, "extensions/acme/other/1.0.0/publish-request.json", "{}");
    });
    await expect(run()).rejects.toThrow(
      /M extensions\/acme\/other\/1\.0\.0\/publish-request\.json/,
    );
  });

  test("rejects a second version directory", async () => {
    const a = await makeExtension(scratch);
    const b = await makeExtension(scratch, { version: "1.1.0" });
    openPr((ws) => {
      writePublish(ws, a);
      writePublish(ws, b);
    });
    await expect(run()).rejects.toThrow(/adds exactly one extensions\/<id>\/<version>\//);
  });

  test("rejects a publish missing one of its three files", async () => {
    const ext = await makeExtension(scratch);
    openPr((ws) => {
      write(ws, "extensions/acme/echo/1.0.0/manifest.json", ext.manifest);
      write(ws, "extensions/acme/echo/1.0.0/package.tgz", ext.pkg);
    });
    await expect(run()).rejects.toThrow(/must add all of manifest\.json/);
  });

  test("rejects a pull request that changes nothing", async () => {
    openPr(() => {});
    await expect(run()).rejects.toThrow("the pull request changes no files");
  });

  test("the shared validator refuses a bad signature", async () => {
    const ext = await makeExtension(scratch, { badSignature: true });
    openPr((ws) => writePublish(ws, ext));
    await expect(run()).rejects.toThrow(/ERR_REGISTRY_SIGNATURE_INVALID/);
    expect(summaries).toEqual([]);
  });

  test("the namespace rule comes from the stricter of gh-pages and the base branch", async () => {
    const ext = await makeExtension(scratch, { id: "other/echo" });
    openPr((ws) => writePublish(ws, ext));
    await expect(run()).rejects.toThrow(/ERR_REGISTRY_NAMESPACE_REQUIRED/);
  });

  test("an id already in the signed index is not flagged NEW ID", async () => {
    const ext = await makeExtension(scratch);
    writePublish(repo.maintainer, ext);
    pushMaintainer(repo, "main", "merge");
    await signMain();
    const next = await makeExtension(scratch, { version: "1.1.0" });
    openPr((ws) => writePublish(ws, next));
    summaries = [];
    await run();
    expect(summaries[0]).not.toContain("NEW ID");
  });

  test("verifies the gh-pages index against its own root key before validating", async () => {
    git(repo.maintainer, "checkout", "-q", "gh-pages");
    const idx = JSON.parse(git(repo.maintainer, "show", "HEAD:index.json")) as Record<
      string,
      unknown
    >;
    idx["sequence"] = 7; // signature no longer covers the bytes
    write(repo.maintainer, "index.json", JSON.stringify(idx));
    pushMaintainer(repo, "gh-pages", "tamper");
    const ext = await makeExtension(scratch);
    openPr((ws) => writePublish(ws, ext));
    await expect(run()).rejects.toThrow(/ERR_REGISTRY_SIGNATURE_INVALID: index signature/);
    expect(validated).toBe(0);
  });

  test("a publisher key conflict is refused", async () => {
    const ext = await makeExtension(scratch);
    writePublish(repo.maintainer, ext);
    pushMaintainer(repo, "main", "merge");
    await signMain();
    const changedKey = await makeExtension(scratch, { version: "2.0.0", seed: OTHER_SEED });
    openPr((ws) => writePublish(ws, changedKey));
    await expect(run()).rejects.toThrow(/ERR_REGISTRY_PUBLISHER_KEY_CONFLICT/);
  });

  test("refuses without a base branch", async () => {
    await expect(runCheck({ workspace: repo.workspace, baseRef: "" }, deps())).rejects.toThrow(
      /GITHUB_BASE_REF\) is empty/,
    );
  });
});

describe("check summary", () => {
  test("renders publisher strings as code spans, never as Markdown", async () => {
    const ext = await makeExtension(scratch, { name: "**bold** <img src=x> `tick`" });
    openPr((ws) => writePublish(ws, ext));
    await run();
    expect(summaries[0]).toContain("- **Name:** `` **bold** <img src=x> `tick` ``");
  });
});

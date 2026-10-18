/**
 * `sign` over real git: a bare origin with `main` and a signed `gh-pages`, a workspace clone, and
 * a maintainer clone that lands "merges" on `main` and races pushes to `gh-pages`. Nothing leaves
 * the temp directory.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signIndex,
  validatePublish,
  verifyRegistryIndexPinned,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import { runSign, type SignDeps } from "./sign.ts";
import {
  b64,
  copyRegistryRepo,
  git,
  makeExtension,
  makeRegistryRepo,
  OTHER_SEED,
  originFile,
  originHead,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_PUBLIC_KEY,
  syncMaintainer,
  write,
  writePublish,
} from "./testing/registry-repo.ts";

// Each test copies real repositories and spawns git dozens of times.
setDefaultTimeout(60_000);

// One registry is built per file and copied per test; building one costs ~15 git spawns.
let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-registry-sign-template-"));
  template = await makeRegistryRepo(join(templateDir, "reg"));
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let warnings: string[];
let summaries: string[];
let validated: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-sign-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = copyRegistryRepo(template, join(tmp, "reg"));
  warnings = [];
  summaries = [];
  validated = 0;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (level, msg) => {
    if (level === "warning") warnings.push(msg);
  },
  summary: (md) => void summaries.push(md),
  log: () => {},
};

function deps(extra: Partial<SignDeps> = {}): SignDeps {
  return {
    git: gitTree,
    io,
    tmpdir: () => scratch,
    sign: signIndex,
    validate: async (...args) => {
      validated++;
      return validatePublish(...args);
    },
    ...extra,
  };
}

const sign = (extra: Partial<SignDeps> = {}, rootKey = ROOT_KEY_INPUT): Promise<void> =>
  runSign({ workspace: repo.workspace, rootKey }, deps(extra));

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function mergePublish(o: Parameters<typeof makeExtension>[1] = {}): Promise<void> {
  syncMaintainer(repo, "main");
  writePublish(repo.maintainer, await makeExtension(scratch, o));
  pushMaintainer(repo, "main", "merge publish");
}

describe("runSign", () => {
  test("sign over two new dirs signs both; a second run is a no-op", async () => {
    await mergePublish();
    await mergePublish({ id: "acme/other", channel: "beta" });
    const mainHead = originHead(repo, "main");
    await sign();

    const index = originIndex(repo);
    await verifyRegistryIndexPinned(index, ROOT_PUBLIC_KEY);
    expect(index.sequence).toBe(2);
    expect(Object.keys(index.extensions).sort()).toEqual(["acme/echo", "acme/other"]);
    const echo = index.extensions["acme/echo"]?.versions["1.0.0"];
    expect(echo?.channel).toBe("stable");
    expect(index.extensions["acme/other"]?.versions["1.0.0"]?.channel).toBe("beta");
    expect(echo?.publishedAt).toBe(
      new Date(git(repo.origin, "log", "-1", "--format=%cI", mainHead).trim()).toISOString(),
    );
    // The site holds the referenced files, byte for byte, and the config copy.
    for (const path of [echo?.manifest ?? "", echo?.package ?? ""]) {
      expect(sha256(originFile(repo, "gh-pages", path))).toBe(
        sha256(originFile(repo, "main", path)),
      );
    }
    expect(originFile(repo, "gh-pages", "nimbus-registry.json")).toEqual(
      originFile(repo, "main", "nimbus-registry.json"),
    );
    expect(git(repo.origin, "log", "-1", "--format=%an <%ae>", "gh-pages").trim()).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    );
    expect(warnings).toEqual([]);

    const pagesHead = originHead(repo, "gh-pages");
    summaries = [];
    await sign();
    expect(originHead(repo, "gh-pages")).toBe(pagesHead);
    expect(summaries[0]).toContain("No change: nothing was committed.");
  });

  test("keeps the site's .nojekyll and .gitattributes across a sign run", async () => {
    const before = originHead(repo, "gh-pages");
    await mergePublish();
    await sign();
    expect(originHead(repo, "gh-pages")).not.toBe(before);
    const tree = git(repo.origin, "ls-tree", "--name-only", "gh-pages").trim().split("\n");
    expect(tree).toContain(".nojekyll");
    expect(tree).toContain(".gitattributes");
    expect(originFile(repo, "gh-pages", ".nojekyll").byteLength).toBe(0);
    expect(new TextDecoder().decode(originFile(repo, "gh-pages", ".gitattributes"))).toBe(
      "* -text\n",
    );
  });

  test("a later publish to an indexed id appends a version at sequence + 1", async () => {
    await mergePublish();
    await sign();
    await mergePublish({ version: "1.1.0" });
    await sign();
    const index = originIndex(repo);
    expect(index.sequence).toBe(3);
    expect(Object.keys(index.extensions["acme/echo"]?.versions ?? {}).sort()).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });

  test("skips an invalid dir with a warning and signs the rest", async () => {
    await mergePublish({ id: "acme/bad", badSignature: true });
    await mergePublish();
    syncMaintainer(repo, "main");
    write(repo.maintainer, "extensions/acme/partial/1.0.0/manifest.json", "{}");
    pushMaintainer(repo, "main", "partial");
    await sign();

    const index = originIndex(repo);
    expect(Object.keys(index.extensions)).toEqual(["acme/echo"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /^skipped extensions\/acme\/bad\/1\.0\.0: ERR_REGISTRY_SIGNATURE_INVALID/,
    );
    expect(warnings[1]).toMatch(/^skipped extensions\/acme\/partial\/1\.0\.0: must hold exactly/);
    expect(summaries[0]).toContain("**Skipped**");

    // Still skipped (never signed) on the next run, which commits nothing.
    const head = originHead(repo, "gh-pages");
    warnings = [];
    await sign();
    expect(originHead(repo, "gh-pages")).toBe(head);
    expect(warnings).toHaveLength(2);
  });

  test("two new dirs are validated against each other: a second key for one publisher is skipped", async () => {
    await mergePublish({ id: "acme/a" });
    await mergePublish({ id: "acme/b", seed: OTHER_SEED });
    await sign();
    expect(Object.keys(originIndex(repo).extensions)).toEqual(["acme/a"]);
    expect(warnings[0]).toMatch(/acme\/b\/1\.0\.0: ERR_REGISTRY_PUBLISHER_KEY_CONFLICT/);
  });

  test.each([
    [
      "a modified signed version",
      (ws: string) => write(ws, "extensions/acme/echo/1.0.0/package.tgz", "tampered"),
      /extensions\/acme\/echo\/1\.0\.0\/package\.tgz differs from the signed version/,
    ],
    [
      "a deleted signed version",
      (ws: string) => rmSync(join(ws, "extensions", "acme"), { recursive: true }),
      /extensions\/acme\/echo\/1\.0\.0\/manifest\.json is signed but was deleted/,
    ],
    [
      "a loosened config",
      (ws: string) =>
        write(ws, "nimbus-registry.json", '{"format":1,"requirePublisherNamespace":false}'),
      /loosens the rules the last signed run used/,
    ],
    [
      "a missing config",
      (ws: string) => rmSync(join(ws, "nimbus-registry.json")),
      /main has no nimbus-registry\.json/,
    ],
  ])("refuses %s, signing and pushing nothing", async (_what, edit, message) => {
    await mergePublish();
    await sign();
    const head = originHead(repo, "gh-pages");
    syncMaintainer(repo, "main");
    edit(repo.maintainer);
    writePublish(repo.maintainer, await makeExtension(scratch, { id: "acme/new" }));
    pushMaintainer(repo, "main", "edit");
    validated = 0;
    await expect(sign()).rejects.toThrow(message);
    expect(originHead(repo, "gh-pages")).toBe(head);
    expect(validated).toBe(0);
  });

  test("refuses a root key that is not the index's, before validating anything", async () => {
    await mergePublish();
    const head = originHead(repo, "gh-pages");
    const wrong = b64(OTHER_SEED);
    const err = await sign({}, wrong).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(
      /the root-key input \(public key fingerprint [0-9a-f]{32}\) is not this registry's root key/,
    );
    expect(err?.message).not.toContain(wrong);
    expect(validated).toBe(0);
    expect(originHead(repo, "gh-pages")).toBe(head);
  });

  test("refuses a gh-pages index whose signature does not verify", async () => {
    await mergePublish();
    syncMaintainer(repo, "gh-pages");
    const idx = originIndex(repo) as unknown as Record<string, unknown>;
    idx["sequence"] = 9;
    write(repo.maintainer, "index.json", JSON.stringify(idx));
    pushMaintainer(repo, "gh-pages", "tamper");
    const head = originHead(repo, "gh-pages");
    await expect(sign()).rejects.toThrow(/ERR_REGISTRY_SIGNATURE_INVALID: index signature/);
    expect(validated).toBe(0);
    expect(originHead(repo, "gh-pages")).toBe(head);
  });

  test("copies a stricter config to gh-pages without re-signing", async () => {
    syncMaintainer(repo, "gh-pages");
    write(
      repo.maintainer,
      "nimbus-registry.json",
      '{"format":1,"requirePublisherNamespace":false}\n',
    );
    pushMaintainer(repo, "gh-pages", "looser site config");
    const before = originIndex(repo);
    await sign();
    expect(originIndex(repo)).toEqual(before);
    expect(originFile(repo, "gh-pages", "nimbus-registry.json")).toEqual(
      originFile(repo, "main", "nimbus-registry.json"),
    );
  });

  test("on a non-fast-forward it re-fetches and retries from the top", async () => {
    await mergePublish();
    const other = await makeExtension(scratch, { id: "acme/other" });
    let raced = 0;
    await sign({
      beforePush: async (attempt) => {
        if (attempt !== 1) return;
        raced++;
        // A REAL concurrent sign lands first: it signs acme/other (sequence 2) from a branch that
        // never saw acme/echo, and acme/other is then merged into main as well.
        syncMaintainer(repo, "main");
        git(repo.maintainer, "checkout", "-q", "-b", "racer", "HEAD~1");
        writePublish(repo.maintainer, other);
        pushMaintainer(repo, "racer", "racer: merge acme/other");
        const racerWs = join(tmp, "racer-ws");
        git(tmp, "clone", "-q", repo.originUrl, racerWs);
        await runSign(
          { workspace: racerWs, rootKey: ROOT_KEY_INPUT, defaultBranch: "racer" },
          deps(),
        );
        expect(originIndex(repo).sequence).toBe(2);
        syncMaintainer(repo, "main");
        writePublish(repo.maintainer, other);
        pushMaintainer(repo, "main", "merge acme/other");
      },
    });
    expect(raced).toBe(1);
    const index = originIndex(repo);
    await verifyRegistryIndexPinned(index, ROOT_PUBLIC_KEY);
    expect(index.sequence).toBe(3);
    expect(Object.keys(index.extensions).sort()).toEqual(["acme/echo", "acme/other"]);
  });

  test("skipped dirs are still warned about when the run then fails", async () => {
    await mergePublish({ id: "acme/bad", badSignature: true });
    await mergePublish();
    git(repo.workspace, "remote", "set-url", "--push", "origin", join(tmp, "nowhere.git"));
    await expect(sign()).rejects.toThrow(/git push to gh-pages failed/);
    expect(warnings).toEqual([expect.stringMatching(/^skipped extensions\/acme\/bad\/1\.0\.0: /)]);
  });

  test("the seed is zeroed when the run ends, and the commit identity cannot be overridden", async () => {
    await mergePublish();
    let seen: Uint8Array | undefined;
    const saved = {
      name: process.env["GIT_AUTHOR_NAME"],
      email: process.env["GIT_COMMITTER_EMAIL"],
    };
    process.env["GIT_AUTHOR_NAME"] = "someone else";
    process.env["GIT_COMMITTER_EMAIL"] = "someone@else.invalid";
    try {
      await sign({
        sign: (unsigned, seed) => {
          seen = seed;
          expect(seed.some((b) => b !== 0)).toBe(true);
          return signIndex(unsigned, seed);
        },
      });
    } finally {
      if (saved.name === undefined) delete process.env["GIT_AUTHOR_NAME"];
      else process.env["GIT_AUTHOR_NAME"] = saved.name;
      if (saved.email === undefined) delete process.env["GIT_COMMITTER_EMAIL"];
      else process.env["GIT_COMMITTER_EMAIL"] = saved.email;
    }
    expect(seen?.every((b) => b === 0)).toBe(true);
    const bot = "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>";
    expect(git(repo.origin, "log", "-1", "--format=%an <%ae>", "gh-pages").trim()).toBe(bot);
    expect(git(repo.origin, "log", "-1", "--format=%cn <%ce>", "gh-pages").trim()).toBe(bot);
  });

  test("the seed is zeroed when the run fails too", async () => {
    await mergePublish();
    let seen: Uint8Array | undefined;
    await expect(
      sign({
        sign: (_unsigned, seed) => {
          seen = seed;
          return Promise.reject(new Error("signer down"));
        },
      }),
    ).rejects.toThrow("signer down");
    expect(seen?.every((b) => b === 0)).toBe(true);
  });

  test("fails after 3 lost races, leaving gh-pages as the racer left it", async () => {
    await mergePublish();
    let n = 0;
    const err = await sign({
      beforePush: () => {
        n++;
        syncMaintainer(repo, "gh-pages");
        write(repo.maintainer, "CNAME", `race ${String(n)}\n`);
        pushMaintainer(repo, "gh-pages", `race ${String(n)}`);
      },
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toMatch(/lost to a concurrent update 3 times/);
    expect(n).toBe(3);
    expect(originIndex(repo).sequence).toBe(1);
  });

  test("a push failure that is not a race fails the run", async () => {
    await mergePublish();
    git(repo.workspace, "remote", "set-url", "--push", "origin", join(tmp, "nowhere.git"));
    await expect(sign()).rejects.toThrow(/git push to gh-pages failed/);
  });

  test("an uninitialised registry says so", async () => {
    git(repo.origin, "branch", "-D", "gh-pages");
    await expect(sign()).rejects.toThrow(gitTree.REGISTRY_NOT_INITIALISED);
  });
});

describe("the root-key input", () => {
  test("accepts the base64 seed `registry maintain init` writes, with its trailing newline", async () => {
    await mergePublish();
    await sign(
      {},
      `${ROOT_KEY_INPUT}
`,
    );
    expect(originIndex(repo).sequence).toBe(2);
  });

  test.each(["", "not base64", `${ROOT_KEY_INPUT}AAAA`, b64(new Uint8Array(64))])(
    "refuses a malformed key without repeating it, before touching git",
    async (raw) => {
      const err = await runSign({ workspace: join(tmp, "no-such-dir"), rootKey: raw }, deps()).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err?.message).toMatch(/input "root-key" is not a registry root key/);
      if (raw !== "") expect(err?.message).not.toContain(raw);
    },
  );
});

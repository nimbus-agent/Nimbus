/**
 * `trust-sign` and `trust-check` over real git: a bare origin with `main` (the feed's source) and a
 * signed `gh-pages:trust.json`, plus a workspace clone. Nothing leaves the temp directory.
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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustFeed,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  readTrustFeedStatements,
  signTrustFeed,
  type TrustFeed,
  verifyTrustFeedPinned,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import {
  b64,
  copyRegistryRepo,
  git,
  makeRotation,
  makeTrustFeedRepo,
  OTHER_SEED,
  originFile,
  originHead,
  PUBLISHER_SEED,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_SEED,
  syncMaintainer,
  write,
  writeStatement,
} from "./testing/registry-repo.ts";
import { runTrustCheck } from "./trust-check.ts";
import { runTrustSign } from "./trust-sign.ts";

setDefaultTimeout(60_000);

const PUB_KEY = b64(publicKeyFromSeed(PUBLISHER_SEED));
const OTHER_KEY = b64(publicKeyFromSeed(OTHER_SEED));

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-trust-modes-template-"));
  template = await makeTrustFeedRepo(join(templateDir, "feed"));
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let repo: RegistryRepo;
let summaries: string[];
let warnings: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-trust-modes-"));
  repo = copyRegistryRepo(template, join(tmp, "feed"));
  summaries = [];
  warnings = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (_level, m) => void warnings.push(m),
  summary: (md) => void summaries.push(md),
  log: () => {},
};

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function verify(root: string, publisherId = "acme", keys = [PUB_KEY]): void {
  write(root, `publishers/${publisherId}.json`, json({ publisherId, keys, github: "acme-dev" }));
}

function revoke(root: string, name = "revoke-1", key = OTHER_KEY): void {
  write(
    root,
    `requests/${name}.json`,
    json({
      kind: "key.revoke",
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(key),
      reason: "leaked",
    }),
  );
}

const sign = (rootKey = ROOT_KEY_INPUT, beforePush?: (n: number) => void | Promise<void>) =>
  runTrustSign(
    { workspace: repo.workspace, rootKey, defaultBranch: "main" },
    { git: gitTree, io, ...(beforePush !== undefined && { beforePush }) },
  );

function originFeed(): TrustFeed {
  return parseTrustFeed(new Uint8Array(originFile(repo, "gh-pages", "trust.json")));
}

const kinds = (f: TrustFeed): string[] =>
  readTrustFeedStatements(f)
    .statements.map((s) => s.kind)
    .sort();

describe("runTrustSign", () => {
  test("a merged verify + revoke is signed once and pushed; a second run commits nothing", async () => {
    verify(repo.maintainer);
    revoke(repo.maintainer);
    pushMaintainer(repo, "main", "verify acme, revoke a key");
    await sign();
    const feed = originFeed();
    expect(feed.sequence).toBe(2);
    expect(kinds(feed)).toEqual(["key.revoke", "publisher.verified"]);
    await verifyTrustFeedPinned(feed, b64(publicKeyFromSeed(ROOT_SEED)));
    expect(summaries.at(-1)).toContain("Signed trust feed sequence 2");
    const head = originHead(repo, "gh-pages");
    await sign();
    expect(originHead(repo, "gh-pages")).toBe(head);
    expect(summaries.at(-1)).toContain("No change");
  });

  test("deleting the request file later keeps the block; un-verifying drops only the badge", async () => {
    verify(repo.maintainer);
    revoke(repo.maintainer);
    pushMaintainer(repo, "main", "add");
    await sign();
    syncMaintainer(repo, "main");
    git(repo.maintainer, "rm", "-q", "requests/revoke-1.json", "publishers/acme.json");
    pushMaintainer(repo, "main", "remove");
    await sign();
    expect(kinds(originFeed())).toEqual(["key.revoke"]);
  });

  test("a verified publisher's statement is carried; a skipped file warns and signs nothing", async () => {
    verify(repo.maintainer);
    writeStatement(repo.maintainer, await makeRotation(PUBLISHER_SEED, OTHER_SEED));
    write(repo.maintainer, "requests/broken.json", "{");
    pushMaintainer(repo, "main", "rotate");
    await sign();
    expect(kinds(originFeed())).toEqual(["key.rotate", "publisher.verified"]);
    expect(warnings.some((w) => w.includes("requests/broken.json"))).toBe(true);
  });

  test("a lost push race starts over from a fresh fetch", async () => {
    verify(repo.maintainer);
    pushMaintainer(repo, "main", "verify");
    let raced = false;
    await sign(ROOT_KEY_INPUT, () => {
      if (raced) return;
      raced = true;
      // Another writer moves gh-pages between this attempt's build and its push.
      syncMaintainer(repo, "gh-pages");
      write(repo.maintainer, "README.md", "moved\n");
      pushMaintainer(repo, "gh-pages", "concurrent");
    });
    expect(raced).toBe(true);
    expect(originFeed().sequence).toBe(2);
    expect(originFile(repo, "gh-pages", "README.md").toString()).toBe("moved\n");
  });

  test("refuses a wrong root key, a tampered gh-pages feed and a missing nimbus-trust.json", async () => {
    verify(repo.maintainer);
    pushMaintainer(repo, "main", "verify");
    const head = originHead(repo, "gh-pages");
    await expect(sign(b64(OTHER_SEED))).rejects.toThrow("is not this feed's root key");
    await expect(sign("not-a-key")).rejects.toThrow('input "root-key" is not a trust root key');
    // Bytes changed under the old signature: the feed no longer verifies against its own root.
    syncMaintainer(repo, "gh-pages");
    const feed = JSON.parse(originFile(repo, "gh-pages", "trust.json").toString()) as TrustFeed;
    write(repo.maintainer, "trust.json", json({ ...feed, sequence: 7 }));
    pushMaintainer(repo, "gh-pages", "tamper");
    await expect(sign()).rejects.toThrow();
    expect(originHead(repo, "gh-pages")).not.toBe(head);
    // A feed whose gh-pages is fine but whose main lost its marker.
    const fresh = copyRegistryRepo(template, join(tmp, "fresh"));
    git(fresh.maintainer, "rm", "-q", "nimbus-trust.json");
    pushMaintainer(fresh, "main", "drop marker");
    await expect(
      runTrustSign(
        { workspace: fresh.workspace, rootKey: ROOT_KEY_INPUT, defaultBranch: "main" },
        { git: gitTree, io },
      ),
    ).rejects.toThrow("no nimbus-trust.json");
  });

  test("a gh-pages without trust.json is not initialised", async () => {
    syncMaintainer(repo, "gh-pages");
    git(repo.maintainer, "rm", "-q", "trust.json");
    pushMaintainer(repo, "gh-pages", "drop feed");
    await expect(sign()).rejects.toThrow("gh-pages has no trust.json");
  });

  test("a feed signed by the input key's sibling is refused before anything is built", async () => {
    syncMaintainer(repo, "gh-pages");
    const resigned = await signTrustFeed(
      {
        format: 1,
        rootKey: OTHER_KEY,
        sequence: 1,
        generatedAt: "2026-10-27T00:00:00Z",
        statements: [],
      },
      OTHER_SEED,
    );
    write(repo.maintainer, "trust.json", json(resigned));
    pushMaintainer(repo, "gh-pages", "other root");
    await expect(sign()).rejects.toThrow("is not this feed's root key");
  });
});

describe("runTrustCheck", () => {
  function openPr(edit: (ws: string) => void): void {
    git(repo.workspace, "fetch", "-q", "origin");
    git(repo.workspace, "checkout", "-q", "-b", "pr", "origin/main");
    edit(repo.workspace);
    git(repo.workspace, "add", "-A");
    git(repo.workspace, "commit", "-q", "--allow-empty", "-m", "pr");
  }

  const check = (baseRef = "main") =>
    runTrustCheck({ workspace: repo.workspace, baseRef }, { git: gitTree, io });

  test("a publisher file passes with the banner naming the handle and key fingerprint", async () => {
    openPr((ws) => verify(ws));
    await check();
    const md = summaries[0] ?? "";
    expect(md).toContain("NIMBUS TRUST FEED");
    expect(md).toContain("`@acme-dev`");
    expect(md).toContain(publisherKeyFingerprint(PUB_KEY));
  });

  test("a block request is summarised", async () => {
    openPr((ws) => revoke(ws));
    await check();
    expect(summaries[0]).toContain("**revoke**");
  });

  test("a pull request editing a workflow or the marker fails", async () => {
    openPr((ws) => {
      verify(ws);
      write(ws, ".github/workflows/trust-sign.yml", "name: evil\n");
    });
    await expect(check()).rejects.toThrow("may only change publishers/, requests/, statements/");
  });

  test("an unparsable or unsignable source file the pull request adds fails", async () => {
    openPr((ws) => write(ws, "requests/broken.json", "{"));
    await expect(check()).rejects.toThrow("would not sign");
    expect(summaries[0]).toContain("requests/broken.json");
  });

  test("an empty pull request and an empty base ref are refused", async () => {
    openPr(() => {});
    await expect(check()).rejects.toThrow("changes no files");
    await expect(check("")).rejects.toThrow("GITHUB_BASE_REF");
  });
});

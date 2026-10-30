/**
 * `sign` with the `scores` input (eval spec § 4.6, ruling R8): `scores.json` is UNTRUSTED input
 * from the secret-free score job, bound to each candidate's `<id>@<version>` and `packageSha256`.
 * Real git, as in `sign.test.ts`; nothing leaves the temp directory.
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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RegistryVersionEntry,
  readVersionQuality,
  signIndex,
  validatePublish,
  verifyRegistryIndexPinned,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import { MAX_SCORES_BYTES, runSign, type SignDeps } from "./sign.ts";
import {
  copyRegistryRepo,
  makeExtension,
  makeRegistryRepo,
  OTHER_SEED,
  originHead,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_PUBLIC_KEY,
  syncMaintainer,
  writePublish,
} from "./testing/registry-repo.ts";

setDefaultTimeout(60_000);

const SUITE = JSON.stringify({ format: 1, name: "basic", cases: [] });
const EVALS = { "basic.eval.json": SUITE };

const QUALITY = {
  scorer: 1,
  score: 50,
  cases: 2,
  passed: 1,
  rubrics: {
    exact: { cases: 2, passed: 1 },
    "json-match": { cases: 0, passed: 0 },
    "one-of": { cases: 0, passed: 0 },
  },
};

/** The fields every signed version entry has, and nothing else (no `provenance` here). */
const FIXED_FIELDS = [
  "channel",
  "entryHash",
  "manifest",
  "manifestSha256",
  "name",
  "package",
  "packageSha256",
  "packageSizeBytes",
  "publishedAt",
];

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-registry-sign-scores-template-"));
  template = await makeRegistryRepo(join(templateDir, "reg"));
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let scoresFile: string;
let warnings: string[];
let summaries: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-sign-scores-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = copyRegistryRepo(template, join(tmp, "reg"));
  scoresFile = join(tmp, "scores.json");
  warnings = [];
  summaries = [];
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

const deps = (): SignDeps => ({
  git: gitTree,
  io,
  tmpdir: () => scratch,
  sign: signIndex,
  validate: validatePublish,
});

/** `sign`, with the `scores` input when `scores` is given. */
const sign = (scores?: string): Promise<void> =>
  runSign(
    { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT, ...(scores !== undefined && { scores }) },
    deps(),
  );

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function publish(
  o: Parameters<typeof makeExtension>[1] = {},
): Promise<{ id: string; version: string; pkgSha: string }> {
  const ext = await makeExtension(scratch, o);
  writePublish(repo.maintainer, ext);
  return { id: ext.id, version: ext.version, pkgSha: sha256(ext.pkg) };
}

function merge(): void {
  pushMaintainer(repo, "main", "merge publish");
}

const writeScores = (value: unknown): string => {
  writeFileSync(scoresFile, typeof value === "string" ? value : JSON.stringify(value));
  return scoresFile;
};

function entryOf(id: string, version = "1.0.0"): RegistryVersionEntry | undefined {
  return originIndex(repo).extensions[id]?.versions[version];
}

describe("sign with the scores input", () => {
  test("absent: an evals version is signed exactly as before, with no quality", async () => {
    await publish({ id: "acme/scored", evals: EVALS });
    merge();
    await sign();
    const entry = entryOf("acme/scored");
    expect(Object.keys(entry ?? {}).sort()).toEqual(FIXED_FIELDS);
    expect(warnings).toEqual([]);
  });

  test("a matching quality is signed into the entry and reads back as scored", async () => {
    const p = await publish({ id: "acme/scored", evals: EVALS });
    merge();
    await sign(writeScores({ "acme/scored@1.0.0": { packageSha256: p.pkgSha, quality: QUALITY } }));
    const index = originIndex(repo);
    await verifyRegistryIndexPinned(index, ROOT_PUBLIC_KEY);
    const entry = entryOf("acme/scored");
    expect(Object.keys(entry ?? {}).sort()).toEqual([...FIXED_FIELDS, "quality"].sort());
    expect(entry?.quality).toEqual(QUALITY);
    expect(entry === undefined ? undefined : readVersionQuality(entry)).toEqual({
      state: "scored",
      quality: QUALITY,
    } as ReturnType<typeof readVersionQuality>);
    expect(summaries.join("\n")).toContain("`acme/scored@1.0.0` (stable), quality 50/100");
    expect(warnings).toEqual([]);
  });

  test("a version without evals/ is signed with no quality while scores is set", async () => {
    await publish({ id: "acme/plain" });
    merge();
    await sign(writeScores({}));
    expect(Object.keys(entryOf("acme/plain") ?? {}).sort()).toEqual(FIXED_FIELDS);
    expect(warnings).toEqual([]);
  });

  test("a version without evals/ ignores an entry for it (the registry did not measure one)", async () => {
    const p = await publish({ id: "acme/plain" });
    merge();
    await sign(writeScores({ "acme/plain@1.0.0": { packageSha256: p.pkgSha, quality: QUALITY } }));
    expect(entryOf("acme/plain")?.quality).toBeUndefined();
  });

  type Case = [label: string, entry: (pkgSha: string) => unknown, reason: RegExp];
  const cases: Case[] = [
    ["no entry", () => undefined, /no score for it/],
    [
      "an error entry",
      (sha) => ({ packageSha256: sha, error: { code: "ERR_EVAL_TIMEOUT", message: "slow" } }),
      /ERR_EVAL_TIMEOUT/,
    ],
    [
      "an error entry with an odd code",
      (sha) => ({ packageSha256: sha, error: { code: "x\n::error::y", message: "m" } }),
      /ERR_EVAL_FAILED/,
    ],
    [
      "another package's digest",
      () => ({ packageSha256: "0".repeat(64), quality: QUALITY }),
      /another package/,
    ],
    [
      "an invalid quality",
      (sha) => ({ packageSha256: sha, quality: { ...QUALITY, score: 99 } }),
      /score is invalid/,
    ],
    [
      "a quality with results",
      (sha) => ({ packageSha256: sha, quality: { ...QUALITY, results: [] } }),
      /unexpected keys: results/,
    ],
    [
      "an entry with an extra key",
      (sha) => ({ packageSha256: sha, quality: QUALITY, note: "hi" }),
      /malformed/,
    ],
    [
      "an entry with both quality and error",
      (sha) => ({ packageSha256: sha, quality: QUALITY, error: { code: "E", message: "m" } }),
      /malformed/,
    ],
    ["an entry that is not an object", () => [1, 2], /malformed/],
    ["an entry that is null", () => null, /malformed/],
    [
      "an error that is not an object",
      (sha) => ({ packageSha256: sha, error: "boom" }),
      /ERR_EVAL_FAILED/,
    ],
  ];

  test.each(cases)(
    "%s: the evals version is skipped, the others are signed",
    async (_l, make, why) => {
      const p = await publish({ id: "acme/scored", evals: EVALS });
      await publish({ id: "acme/plain" });
      merge();
      const head = originHead(repo, "gh-pages");
      const e = make(p.pkgSha);
      await sign(writeScores(e === undefined ? {} : { "acme/scored@1.0.0": e }));
      expect(originHead(repo, "gh-pages")).not.toBe(head);
      expect(entryOf("acme/scored")).toBeUndefined();
      expect(entryOf("acme/plain")).toBeDefined();
      const warning = warnings.find((w) => w.includes("extensions/acme/scored/1.0.0")) ?? "";
      expect(warning).toMatch(why);
      expect(warning).not.toContain("\n");
      expect(summaries.join("\n")).toContain("extensions/acme/scored/1.0.0");
    },
  );

  test("__proto__ and toString keys are plain keys: they neither match nor break the lookup", async () => {
    const p = await publish({ id: "acme/scored", evals: EVALS });
    await publish({ id: "acme/other", evals: EVALS });
    merge();
    const good = JSON.stringify({ packageSha256: p.pkgSha, quality: QUALITY });
    await sign(
      writeScores(
        `{"__proto__": ${good}, "toString": ${good}, "constructor": 1, "acme/scored@1.0.0": ${good}}`,
      ),
    );
    expect(entryOf("acme/scored")?.quality).toEqual(QUALITY);
    expect(entryOf("acme/other")).toBeUndefined();
    expect(warnings.join("\n")).toMatch(/acme\/other\/1\.0\.0.*no score for it/);
  });

  test("a version skipped for its score binds nothing for the next candidate", async () => {
    // Two first versions of one new id under different keys: were the unscored 1.0.0 bound,
    // 1.1.0 would be refused for its key. It is judged against the signed index alone.
    await publish({ id: "acme/x", version: "1.0.0", evals: EVALS });
    const next = await publish({ id: "acme/x", version: "1.1.0", seed: OTHER_SEED, evals: EVALS });
    merge();
    await sign(writeScores({ "acme/x@1.1.0": { packageSha256: next.pkgSha, quality: QUALITY } }));
    expect(entryOf("acme/x", "1.0.0")).toBeUndefined();
    expect(entryOf("acme/x", "1.1.0")?.quality).toEqual(QUALITY);
  });

  test.each([
    ["an unreadable file", (): string => join(tmp, "absent.json"), /could not be read/],
    ["an array", (): string => writeScores([]), /not a JSON object/],
    ["null", (): string => writeScores("null"), /not a JSON object/],
    ["garbage", (): string => writeScores("{not json"), /not valid JSON/],
    [
      "a file over 4 MiB",
      (): string => writeScores(`{${" ".repeat(MAX_SCORES_BYTES)}}`),
      /larger than 4194304 bytes/,
    ],
  ])("%s fails the whole run, signing and pushing nothing", async (_l, path, why) => {
    await publish({ id: "acme/plain" });
    merge();
    const head = originHead(repo, "gh-pages");
    await expect(sign(path())).rejects.toThrow(why);
    expect(originHead(repo, "gh-pages")).toBe(head);
  });

  test("a file of exactly 4 MiB is read", async () => {
    await publish({ id: "acme/plain" });
    merge();
    await sign(writeScores(`{${" ".repeat(MAX_SCORES_BYTES - 2)}}`));
    expect(entryOf("acme/plain")).toBeDefined();
    expect(MAX_SCORES_BYTES).toBe(4 * 1024 * 1024);
  });

  test("a retry after a lost push re-reads nothing and signs the same quality", async () => {
    const p = await publish({ id: "acme/scored", evals: EVALS });
    merge();
    let raced = false;
    await runSign(
      {
        workspace: repo.workspace,
        rootKey: ROOT_KEY_INPUT,
        scores: writeScores({ "acme/scored@1.0.0": { packageSha256: p.pkgSha, quality: QUALITY } }),
      },
      {
        ...deps(),
        beforePush: () => {
          if (raced) return;
          raced = true;
          // The file vanishing after the run read it changes nothing: it is read once.
          rmSync(scoresFile);
          syncMaintainer(repo, "gh-pages");
          writeFileSync(join(repo.maintainer, "unrelated.txt"), "x");
          pushMaintainer(repo, "gh-pages", "concurrent");
        },
      },
    );
    expect(entryOf("acme/scored")?.quality).toEqual(QUALITY);
  });
});

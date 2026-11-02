/**
 * The score → sign seam (eval spec § 4.6, ruling R8), end to end over one real registry repo: the
 * `score` mode writes the real `scores.json` (only the role is faked), and the `sign` mode reads
 * that very file as its `scores` input. Each half has its own suite (`score.test.ts`,
 * `sign-scores.test.ts`); this one proves that what score writes is what sign accepts.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVersionBaseline,
  readVersionQuality,
  signIndex,
  validatePublish,
  verifyRegistryIndexPinned,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import { runScore } from "./score.ts";
import type { RoleRun } from "./score-role.ts";
import { runSign } from "./sign.ts";
import {
  makeExtension,
  makeRegistryRepo,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_PUBLIC_KEY,
  writePublish,
} from "./testing/registry-repo.ts";

setDefaultTimeout(60_000);

const EVALS = { "basic.eval.json": JSON.stringify({ format: 1, name: "basic", cases: [] }) };

const REPORT = {
  scorer: 1 as const,
  score: 50,
  cases: 2,
  passed: 1,
  rubrics: {
    exact: { cases: 2, passed: 1 },
    "json-match": { cases: 0, passed: 0 },
    "one-of": { cases: 0, passed: 0 },
  },
  results: [
    { suite: "basic", case: "a", rubric: "exact", pass: true, reason: null },
    { suite: "basic", case: "b", rubric: "exact", pass: false, reason: "mismatch" },
  ],
};
const { results: _results, ...QUALITY } = REPORT;

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let warnings: string[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-score-sign-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = await makeRegistryRepo(join(tmp, "reg"));
  warnings = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (level, msg) => {
    if (level === "warning") warnings.push(msg);
  },
  summary: () => {},
  log: () => {},
};

const roleRun = (over: Partial<RoleRun>): RoleRun => ({
  code: 0,
  stdout: "",
  stderrTail: "",
  timedOut: false,
  overflow: false,
  ...over,
});

/** The fake role: reads the extracted manifest and scores `acme/scored`, fails `acme/broken`. */
async function fakeRole(_gateway: string, dir: string): Promise<RoleRun> {
  const m = JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
    id: string;
    version: string;
  };
  if (m.id === "acme/broken") return roleRun({ code: 1, stderrTail: "the suite crashed" });
  const doc = { ok: true, extensionId: m.id, version: m.version, report: REPORT };
  return roleRun({ stdout: `${JSON.stringify(doc)}\n` });
}

const BASELINE = { scorer: 1 as const, passed: true as const, tools: 3 };

/** The fake baseline role: every package starts and lists three tools. */
async function fakeBaseline(_gateway: string, dir: string): Promise<RoleRun> {
  const m = JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
    id: string;
    version: string;
  };
  const doc = { ok: true, extensionId: m.id, version: m.version, baseline: BASELINE };
  return roleRun({ stdout: `${JSON.stringify(doc)}\n` });
}

async function publish(o: Parameters<typeof makeExtension>[1]): Promise<string> {
  const ext = await makeExtension(scratch, o);
  writePublish(repo.maintainer, ext);
  return createHash("sha256").update(ext.pkg).digest("hex");
}

test("score writes scores.json, and sign signs from that same file", async () => {
  const scoredSha = await publish({ id: "acme/scored", evals: EVALS });
  const brokenSha = await publish({ id: "acme/broken", evals: EVALS });
  const plainSha = await publish({ id: "acme/plain" });
  pushMaintainer(repo, "main", "publish three");

  const gateway = join(tmp, "nimbus-gateway");
  writeFileSync(gateway, "not run: the role is faked");
  const scoresFile = join(tmp, "runner-temp", "registry-scores", "scores.json");
  mkdirSync(join(tmp, "runner-temp", "registry-scores"), { recursive: true });
  await runScore(
    { workspace: repo.workspace, gateway, out: scoresFile, defaultBranch: "main" },
    {
      validate: validatePublish,
      git: gitTree,
      io,
      tmpdir: () => scratch,
      runRole: fakeRole,
      runBaseline: fakeBaseline,
      now: () => 0,
    },
  );
  // What score wrote: a quality and a baseline, an error and a baseline, and a baseline alone for
  // the version without evals/.
  const written = JSON.parse(readFileSync(scoresFile, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written).sort()).toEqual([
    "acme/broken@1.0.0",
    "acme/plain@1.0.0",
    "acme/scored@1.0.0",
  ]);
  expect(written["acme/scored@1.0.0"]).toEqual({
    packageSha256: scoredSha,
    quality: QUALITY,
    baseline: BASELINE,
  });
  expect(written["acme/plain@1.0.0"]).toEqual({ packageSha256: plainSha, baseline: BASELINE });
  expect(written["acme/broken@1.0.0"]).toMatchObject({
    packageSha256: brokenSha,
    error: { code: "ERR_EVAL_ROLE_FAILED" },
    baseline: BASELINE,
  });

  await runSign(
    { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT, scores: scoresFile },
    { validate: validatePublish, sign: signIndex, git: gitTree, io, tmpdir: () => scratch },
  );

  const extensions = originIndex(repo).extensions;
  // The signed index, baselines included, verifies against the root key a client pins.
  await verifyRegistryIndexPinned(originIndex(repo), ROOT_PUBLIC_KEY);
  // Scored: signed with exactly that quality, byte for byte, and the baseline beside it.
  const scored = extensions["acme/scored"]?.versions["1.0.0"];
  expect(JSON.stringify(scored?.quality)).toBe(JSON.stringify(QUALITY));
  expect(scored === undefined ? undefined : readVersionBaseline(scored)).toEqual({
    state: "checked",
    baseline: BASELINE,
  } as ReturnType<typeof readVersionBaseline>);
  expect(scored === undefined ? undefined : readVersionQuality(scored)).toEqual({
    state: "scored",
    quality: QUALITY,
  } as ReturnType<typeof readVersionQuality>);
  // Errored: skipped, absent from the index, with a warning naming it.
  expect(extensions["acme/broken"]).toBeUndefined();
  expect(warnings.some((w) => w.includes("extensions/acme/broken/1.0.0"))).toBe(true);
  // No evals/: signed, with a baseline and no quality.
  const plain = extensions["acme/plain"]?.versions["1.0.0"];
  expect(plain).toBeDefined();
  expect(plain?.quality).toBeUndefined();
  expect(plain === undefined ? undefined : readVersionBaseline(plain)).toEqual({
    state: "checked",
    baseline: BASELINE,
  } as ReturnType<typeof readVersionBaseline>);
  expect(plain === undefined ? undefined : readVersionQuality(plain)).toEqual({
    state: "unscored",
  } as ReturnType<typeof readVersionQuality>);
});

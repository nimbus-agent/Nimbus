/**
 * The producer-to-client chain, end to end and offline: a real fixture registry repo, the registry
 * action's `sign`, `liveness-check` and `liveness-sign` (FAKE sandboxed roles and a FAKE host
 * probe), then this gateway's client side - `parseRegistryIndex`, `readRegistryLivenessKey`,
 * `parseLivenessFile`, `verifyLivenessFile`, `readLivenessEntry` and `checkedEvidence`. It pins that
 * the file name, keys, version and entry shapes the producer writes are the ones the client reads.
 * Nothing leaves the temp directory.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLivenessFile,
  parseRegistryIndex,
  publicKeyFromSeed,
  readLivenessEntry,
  readRegistryLivenessKey,
  signIndex,
  validatePublish,
  verifyLivenessFile,
} from "@nimbus-dev/registry-format";
import * as gitTree from "../../../../github-actions/registry-action/src/git-tree.ts";
import { runLivenessCheck } from "../../../../github-actions/registry-action/src/liveness-check.ts";
import { runLivenessSign } from "../../../../github-actions/registry-action/src/liveness-sign.ts";
import { runSign } from "../../../../github-actions/registry-action/src/sign.ts";
import {
  b64,
  makeExtension,
  makeRegistryRepo,
  originFile,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  ROOT_SEED,
  syncMaintainer,
  write,
  writePublish,
} from "../../../../github-actions/registry-action/src/testing/registry-repo.ts";
import { checkedEvidence } from "./version-evidence.ts";

setDefaultTimeout(120_000);

const VERSION = "10.14.1";
const SUITE = JSON.stringify({ format: 1, name: "basic", cases: [] });
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
const quiet = { annotate: () => {}, summary: () => {}, log: () => {} };
const done = (stdout: string, code = 0) => ({
  code,
  stdout,
  stderrTail: code === 0 ? "" : "boom",
  timedOut: false,
  overflow: false,
});
const idOf = (dir: string): { id: string; version: string } =>
  JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
    id: string;
    version: string;
  };

let dir: string;
let scratch: string;
let repo: RegistryRepo;
const LIVENESS_SEED = new Uint8Array(32).fill(9);
const LIVENESS_KEY = b64(publicKeyFromSeed(LIVENESS_SEED));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-liveness-e2e-"));
  scratch = join(dir, "scratch");
  mkdirSync(scratch);
  repo = await makeRegistryRepo(join(dir, "reg"));
  for (const o of [
    {
      id: "acme/a",
      evals: { "basic.eval.json": SUITE },
      network: ["api.example.com", "imap.example.com:993", "smtp.example.com:25"],
    },
    { id: "acme/other", network: [] as string[] },
  ]) {
    writePublish(repo.maintainer, await makeExtension(scratch, o));
  }
  pushMaintainer(repo, "main", "publish");
  await runSign(
    { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
    { validate: validatePublish, sign: signIndex, git: gitTree, io: quiet, tmpdir: () => scratch },
  );
  // Opt in, as `nimbus registry maintain set-liveness-key` does.
  syncMaintainer(repo, "gh-pages");
  const { signature: _s, ...rest } = originIndex(repo) as unknown as Record<string, unknown>;
  const next = await signIndex(
    { ...rest, sequence: (rest["sequence"] as number) + 1, livenessKey: LIVENESS_KEY } as never,
    ROOT_SEED,
  );
  write(repo.maintainer, "index.json", `${JSON.stringify(next, null, 2)}\n`);
  pushMaintainer(repo, "gh-pages", "set liveness key");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("liveness producer to client", () => {
  test("check, sign, then the client verifies, reads and renders; a second run is sequence 2", async () => {
    const t0 = Date.parse("2026-11-02T05:23:00Z");
    let now = t0;
    const out = join(dir, "liveness-results.json");
    const gateway = join(dir, "gw");
    writeFileSync(gateway, "not run: the role is faked");
    await runLivenessCheck(
      { workspace: repo.workspace, gateway, nimbusVersion: VERSION, out },
      {
        git: gitTree,
        io: quiet,
        tmpdir: () => scratch,
        now: () => now,
        probe: {
          lookup: async (h) => [
            { address: h === "smtp.example.com" ? "10.0.0.5" : "93.184.216.34", family: 4 },
          ],
          connect: async () => true,
        },
        runRole: async (_g, d) => {
          const m = idOf(d);
          return done(
            `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, report: REPORT })}\n`,
          );
        },
        runBaseline: async (_g, d) => {
          const m = idOf(d);
          const baseline = { scorer: 1, passed: true, tools: 3 };
          return done(
            `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, baseline })}\n`,
          );
        },
      },
    );
    now = t0 + 20 * 60_000; // the sign job runs later
    const warns: string[] = [];
    await runLivenessSign(
      {
        workspace: repo.workspace,
        livenessKey: b64(LIVENESS_SEED),
        results: out,
        nimbusVersion: VERSION,
      },
      {
        git: gitTree,
        io: { ...quiet, annotate: (_l, m) => void warns.push(m) },
        now: () => now,
      },
    );
    expect(warns).toEqual([]);

    // The client side, on exactly the bytes the producer committed.
    const index = parseRegistryIndex(originFile(repo, "gh-pages", "index.json"));
    const key = readRegistryLivenessKey(index);
    expect(key).toBe(LIVENESS_KEY);
    const doc = parseLivenessFile(new Uint8Array(originFile(repo, "gh-pages", "liveness.json")));
    await verifyLivenessFile(doc, key as string);
    expect(doc.sequence).toBe(1);
    expect(doc.nimbusVersion).toBe(VERSION);
    const ea = readLivenessEntry(doc, "acme/a", "1.0.0");
    const eo = readLivenessEntry(doc, "acme/other", "1.0.0");
    expect(ea.state).toBe("found");
    expect(eo.state).toBe("found");
    const text = (entry: typeof ea): string =>
      String(
        checkedEvidence({
          registry: "test",
          starterPack: false,
          now: now + 3_600_000,
          liveness: { state: "verified", nimbusVersion: doc.nimbusVersion, entry },
        }).text,
      );
    expect(text(ea)).toContain("2 of 3 declared hosts answered");
    expect(text(ea)).toContain("1 of 2 cases passed");
    expect(text(ea)).not.toMatch(/\bworks\b/i);
    expect(text(eo)).toContain("starts and lists 3 valid tools");

    // A second weekly run with failing roles: sequence 2, and index.json is never touched.
    const indexBefore = originFile(repo, "gh-pages", "index.json").toString("utf8");
    now += 7 * 86_400_000;
    await runLivenessCheck(
      { workspace: repo.workspace, gateway, nimbusVersion: VERSION, out },
      {
        git: gitTree,
        io: quiet,
        tmpdir: () => scratch,
        now: () => now,
        probe: {
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          connect: async () => false,
        },
        runRole: async () => done("", 1),
        runBaseline: async () => done("", 1),
      },
    );
    await runLivenessSign(
      {
        workspace: repo.workspace,
        livenessKey: b64(LIVENESS_SEED),
        results: out,
        nimbusVersion: VERSION,
      },
      { git: gitTree, io: quiet, now: () => now + 60_000 },
    );
    const doc2 = parseLivenessFile(new Uint8Array(originFile(repo, "gh-pages", "liveness.json")));
    await verifyLivenessFile(doc2, key as string);
    expect(doc2.sequence).toBe(2);
    expect(originFile(repo, "gh-pages", "index.json").toString("utf8")).toBe(indexBefore);
    const second = readLivenessEntry(doc2, "acme/a", "1.0.0");
    expect(second.state).toBe("found");
    expect(
      String(
        checkedEvidence({
          registry: "test",
          starterPack: false,
          now: now + 3_600_000,
          liveness: { state: "verified", nimbusVersion: doc2.nimbusVersion, entry: second },
        }).text,
      ),
    ).toContain("no declared host answered");
  });
});

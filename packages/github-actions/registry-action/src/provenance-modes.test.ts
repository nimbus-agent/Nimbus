/**
 * Build provenance through `sign` and `check` over real git (trust layer PR 4c). The `gh` call is
 * injected (`provenance` dep): these tests prove what the modes do with its answer — record it once,
 * for the bytes signed, and never let it block.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readVersionProvenance,
  signIndex,
  type VersionProvenance,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import { runCheck } from "./check.ts";
import * as gitTree from "./git-tree.ts";
import type { ProvenanceResult, VerifyPackage } from "./provenance.ts";
import type { ActionIo } from "./report.ts";
import { runSign } from "./sign.ts";
import {
  copyRegistryRepo,
  git,
  makeExtension,
  makeRegistryRepo,
  originIndex,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  syncMaintainer,
  writePublish,
} from "./testing/registry-repo.ts";

setDefaultTimeout(60_000);

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-provenance-template-"));
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-provenance-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = copyRegistryRepo(template, join(tmp, "reg"));
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

const PROV: VersionProvenance = {
  sourceRepository: "acme/echo",
  commit: "c".repeat(40),
  workflow: ".github/workflows/release.yml@refs/tags/v1.0.0",
  runner: "github-hosted",
  verifiedAt: "2026-10-27T00:00:00.000Z",
};

/** A verifier that records what it was handed and answers `answer` (verifiedAt passed through). */
function verifier(answer: (repository: string) => ProvenanceResult) {
  const calls: Array<{ bytesSha256: string; repository: string; verifiedAt: string }> = [];
  const verify: VerifyPackage = (pkgPath, repository, verifiedAt) => {
    calls.push({
      bytesSha256: createHash("sha256").update(readFileSync(pkgPath)).digest("hex"),
      repository,
      verifiedAt,
    });
    const r = answer(repository);
    return Promise.resolve(r.ok ? { ok: true, provenance: { ...r.provenance, verifiedAt } } : r);
  };
  return { verify, calls };
}

async function mergePublish(o: Parameters<typeof makeExtension>[1] = {}): Promise<void> {
  syncMaintainer(repo, "main");
  writePublish(repo.maintainer, await makeExtension(scratch, o));
  pushMaintainer(repo, "main", "merge publish");
}

const sign = (verify: VerifyPackage) =>
  runSign(
    { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
    {
      git: gitTree,
      io,
      tmpdir: () => scratch,
      sign: signIndex,
      validate: validatePublish,
      provenance: verify,
    },
  );

const versionEntry = (id = "acme/echo", version = "1.0.0"): unknown =>
  originIndex(repo).extensions[id]?.versions[version];

describe("sign records provenance", () => {
  test("for a declared repository it is verified over the signed bytes and recorded", async () => {
    await mergePublish({ repository: "acme/echo" });
    const v = verifier(() => ({ ok: true, provenance: PROV }));
    await sign(v.verify);
    const entry = versionEntry() as { packageSha256: string; publishedAt: string };
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]?.bytesSha256).toBe(entry.packageSha256);
    expect(v.calls[0]?.repository).toBe("acme/echo");
    expect(readVersionProvenance(entry)).toEqual({ ...PROV, verifiedAt: entry.publishedAt });
    expect(warnings).toEqual([]);
  });

  test("a failed verification signs the version anyway, without provenance, with one warning", async () => {
    await mergePublish({ repository: "acme/echo" });
    const v = verifier(() => ({ ok: false, reason: "no attestation found for the package" }));
    await sign(v.verify);
    const entry = versionEntry();
    expect(entry).toBeDefined();
    expect(readVersionProvenance(entry)).toBeUndefined();
    expect(Object.hasOwn(entry as object, "provenance")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no provenance for acme/echo@1.0.0");
  });

  test("no repository: gh is never asked", async () => {
    await mergePublish();
    const v = verifier(() => ({ ok: true, provenance: PROV }));
    await sign(v.verify);
    expect(v.calls).toEqual([]);
    expect(Object.hasOwn(versionEntry() as object, "provenance")).toBe(false);
  });

  test("a throwing verifier never blocks the sign", async () => {
    await mergePublish({ repository: "acme/echo" });
    await sign(() => Promise.reject(new Error("boom")));
    expect(versionEntry()).toBeDefined();
    expect(Object.hasOwn(versionEntry() as object, "provenance")).toBe(false);
    expect(warnings[0]).toContain("verification failed: boom");
  });

  test("a push-race retry asks gh once and stamps this attempt's commit time", async () => {
    await mergePublish({ repository: "acme/echo" });
    const v = verifier(() => ({ ok: true, provenance: PROV }));
    let raced = false;
    await runSign(
      { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
      {
        git: gitTree,
        io,
        tmpdir: () => scratch,
        sign: signIndex,
        validate: validatePublish,
        provenance: v.verify,
        beforePush: () => {
          if (raced) return;
          raced = true;
          syncMaintainer(repo, "gh-pages");
          writePublish(repo.maintainer, {
            id: "x",
            version: "0",
            manifest: new Uint8Array(),
            pkg: new Uint8Array(),
            request: new Uint8Array(),
          });
          pushMaintainer(repo, "gh-pages", "concurrent");
        },
      },
    );
    expect(raced).toBe(true);
    expect(v.calls).toHaveLength(1);
    const entry = versionEntry() as { publishedAt: string };
    expect(readVersionProvenance(entry)?.verifiedAt).toBe(entry.publishedAt);
  });

  test("a malformed repository is ignored: gh is never asked", async () => {
    await mergePublish({ repository: "https://github.com/acme/echo" });
    const v = verifier(() => ({ ok: true, provenance: PROV }));
    await sign(v.verify);
    expect(v.calls).toEqual([]);
    expect(versionEntry()).toBeDefined();
  });

  test("an already-signed version is never re-verified", async () => {
    await mergePublish({ repository: "acme/echo" });
    const first = verifier(() => ({ ok: false, reason: "down" }));
    await sign(first.verify);
    await mergePublish({ repository: "acme/echo", version: "1.1.0" });
    const second = verifier(() => ({ ok: true, provenance: PROV }));
    await sign(second.verify);
    expect(second.calls).toHaveLength(1);
    expect(readVersionProvenance(versionEntry("acme/echo", "1.0.0"))).toBeUndefined();
    expect(readVersionProvenance(versionEntry("acme/echo", "1.1.0"))).toBeDefined();
  });
});

describe("check reports provenance and never fails on it", () => {
  function openPr(o: Parameters<typeof makeExtension>[1]): Promise<void> {
    return makeExtension(scratch, o).then((ext) => {
      git(repo.workspace, "fetch", "-q", "origin");
      git(repo.workspace, "checkout", "-q", "-b", "pr", "origin/main");
      writePublish(repo.workspace, ext);
      git(repo.workspace, "add", "-A");
      git(repo.workspace, "commit", "-q", "-m", "pr");
    });
  }

  const check = (verify: VerifyPackage) =>
    runCheck(
      { workspace: repo.workspace, baseRef: "main" },
      { git: gitTree, io, tmpdir: () => scratch, validate: validatePublish, provenance: verify },
    );

  test("verified", async () => {
    await openPr({ repository: "acme/echo" });
    await check(verifier(() => ({ ok: true, provenance: PROV })).verify);
    expect(summaries[0]).toContain("**Provenance:** built from `acme/echo` at `cccccccccccc`");
  });

  test("not verified: the reason is shown and the check passes", async () => {
    await openPr({ repository: "acme/echo" });
    await check(verifier(() => ({ ok: false, reason: "gh: HTTP 404: Not Found" })).verify);
    expect(summaries[0]).toContain("**Provenance:** none for `acme/echo`");
    expect(summaries[0]).toContain("HTTP 404");
  });

  test("a throwing verifier does not fail the check", async () => {
    await openPr({ repository: "acme/echo" });
    await check(() => Promise.reject(new Error("boom")));
    expect(summaries[0]).toContain("verification failed: boom");
  });

  test("a malformed repository is reported as ignored", async () => {
    await openPr({ repository: "acme/echo/extra" });
    await check(verifier(() => ({ ok: true, provenance: PROV })).verify);
    expect(summaries[0]).toContain("is not `owner/repo`, so it is ignored");
  });

  test("no repository declared", async () => {
    await openPr({});
    const v = verifier(() => ({ ok: true, provenance: PROV }));
    await check(v.verify);
    expect(v.calls).toEqual([]);
    expect(summaries[0]).toContain("declares no `repository`");
  });
});

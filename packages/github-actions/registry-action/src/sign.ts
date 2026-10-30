/**
 * `mode: sign` — the content boundary, run behind the `registry-signing` environment's required
 * approval (design § 7.4, § 11.6–11.8). Every attempt starts from a fresh fetch of the default
 * branch and `gh-pages`, and refuses — failing the run with nothing signed or pushed — when:
 *
 * - the signed `gh-pages` index does not verify against its own root key;
 * - the `root-key` input's public half is not that index's `rootKey`;
 * - the default branch's `nimbus-registry.json` is missing or loosens `gh-pages`'s copy (§ 11.6);
 * - an already-signed version's `manifest.json` or `package.tgz` changed or was deleted (§ 11.7).
 *
 * Only then is every unsigned `extensions/<id>/<version>/` validated with `validatePublish` against
 * the signed bindings (plus the ones this run adds before it). A dir that fails is SKIPPED with a
 * `::warning::` and a summary line and the run still succeeds (§ 11.8). Passing dirs become entries,
 * the index is re-signed at `sequence + 1`, and the site is committed to `gh-pages` and pushed; a
 * push that loses a race starts over from the top, at most `MAX_ATTEMPTS` times. Nothing new means
 * no new signature and no commit.
 *
 * With the `scores` input (eval spec § 4.6, ruling R8), `scores.json` from the secret-free score job
 * is read ONCE per run, as untrusted input: a version whose package holds eval suites is signed
 * only with a valid score bound to its own `<id>@<version>` and `packageSha256`, and that score
 * becomes its `quality`; without one it is skipped (and binds nothing for later candidates). A
 * version without eval suites is signed with no `quality`. Without the input, nothing changes.
 *
 * The root key is a secret. It is parsed in memory only, never written to disk, and never named in
 * a message: refusals name fingerprints of PUBLIC keys. `main.ts` masks the input before this runs.
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { join } from "node:path";
import {
  alreadyCarried,
  codeUnitCompare,
  type EvalQuality,
  type PublishVerdict,
  parseEvalQuality,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryIndex,
  readRegistryReportUrl,
  signIndex,
  signRegistryRequest,
  type TrustStatement,
  trustStatementId,
  type VersionProvenance,
  validatePublish,
  verifyRegistryIndexPinned,
} from "../../../registry-format/src/index.ts";
import {
  addVersion,
  admitStatements,
  assertSignedIntact,
  type CandidateOutcome,
  extensionDirs,
  type Skipped,
  validateUnsigned,
} from "./candidates.ts";
import * as gitTree from "./git-tree.ts";
import {
  ghProvenance,
  type ProvenanceResult,
  type VerifyPackage,
  verifyNeverThrowing,
} from "./provenance.ts";
import {
  CONFIG_FILE,
  INDEX_FILE,
  loosens,
  PAGES_BRANCH,
  PAGES_REF,
  readConfigAt,
  readRequestFiles,
  readVerifiedIndex,
} from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import { commitSite, pushCommit, type SiteFile } from "./site-commit.ts";

/** Inputs `sign` needs. */
export interface SignOptions {
  /** The registry repository's checkout. */
  workspace: string;
  /** The `root-key` input: base64 of the 32-byte Ed25519 seed `registry maintain init` writes. */
  rootKey: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
  /** `<owner>/<repo>` (`GITHUB_REPOSITORY`): sets the index's report URL when it has none. */
  repository?: string;
  /** The `github-token` input: what `gh attestation verify` fetches attestations with. */
  githubToken?: string;
  /** The `scores` input: the path of the score job's `scores.json`; absent means no `quality`. */
  scores?: string;
}

/** What `sign` reads, judges, signs and reports with; injectable for tests. */
export interface SignDeps {
  validate: typeof validatePublish;
  sign: typeof signIndex;
  git: typeof gitTree;
  io: ActionIo;
  /** Where the validator's scratch directory goes. */
  tmpdir: () => string;
  /** Called between building the commit and pushing it; tests race a concurrent push here. */
  beforePush?: (attempt: number) => void | Promise<void>;
  /**
   * Verifies a package's build provenance (`gh attestation verify`); the default runs `gh` with the
   * `github-token` input. Never throws: a failure is a reason.
   */
  provenance?: VerifyPackage;
}

const SHARED: SignDeps = {
  validate: validatePublish,
  sign: signIndex,
  git: gitTree,
  io: GHA_IO,
  tmpdir: osTmpdir,
};

/** Fetch-validate-sign-push attempts before a push that keeps losing the race fails the run. */
const MAX_ATTEMPTS = 3;

const ROOT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The 32-byte seed in the `root-key` input. A malformed key is refused with a message that does
 * not repeat it.
 */
function parseRootKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (!ROOT_KEY_RE.test(s)) {
    throw new Error(
      'input "root-key" is not a registry root key: expected the base64 of a 32-byte Ed25519 seed, as `nimbus registry maintain init` writes it',
    );
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

interface Added {
  id: string;
  version: string;
  channel: string;
  quality?: EvalQuality;
}

/** The most bytes the `scores` input may hold; a larger file fails the run. */
export const MAX_SCORES_BYTES = 4 * 1024 * 1024;

/** `scores.json`, read once: its entries by key (`<id>@<version>`), still UNTRUSTED. */
export type Scores = ReadonlyMap<string, unknown>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function refuseScores(path: string, why: string): Error {
  return new Error(`refusing to sign: the scores input (${path}) ${why}`);
}

/** At most `max` bytes of the file at `path`, however large the file is. */
function readAtMost(path: string, max: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(max);
    let n = 0;
    let got = -1;
    while (n < max && got !== 0) {
      got = readSync(fd, buf, n, max - n, null);
      n += got;
    }
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The `scores` input, read once. A file that is unreadable, over `MAX_SCORES_BYTES`, not JSON or
 * not a JSON object fails the run: a broken artifact is not "no scores". The entries go into a
 * `Map`, so an untrusted key (`__proto__`, `toString`) is only ever a key.
 */
export function readScores(path: string): Scores {
  let bytes: Uint8Array;
  try {
    bytes = readAtMost(path, MAX_SCORES_BYTES + 1);
  } catch (e) {
    throw refuseScores(path, `could not be read: ${errorText(e)}`);
  }
  if (bytes.byteLength > MAX_SCORES_BYTES) {
    throw refuseScores(path, `is larger than ${String(MAX_SCORES_BYTES)} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw refuseScores(path, "is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw refuseScores(path, "is not a JSON object");
  return new Map(Object.entries(parsed));
}

/** What a candidate's `scores.json` entry decides: sign (with a quality, or none), or skip. */
export type QualityDecision = { ok: true; quality?: EvalQuality } | { ok: false; reason: string };

const MALFORMED =
  "its scores.json entry is malformed (want exactly packageSha256 and one of quality or error); not signed without a score";

/** A failed entry's error code when it looks like one; otherwise a fixed one. */
function failedCode(error: unknown): string {
  const c = isPlainObject(error) ? error["code"] : undefined;
  return typeof c === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : "ERR_EVAL_FAILED";
}

/**
 * The `quality` to sign for `v`, judged from the untrusted `scores` (ruling R8). No input, or no
 * eval suite in the package: sign with no quality. Otherwise only an entry under `v`'s own
 * `<id>@<version>`, for `v`'s own `packageSha256`, holding a quality `parseEvalQuality` accepts
 * signs it, and the quality signed is the one `parseEvalQuality` rebuilt (exactly its five keys).
 */
export function qualityFor(
  scores: Scores | undefined,
  v: Pick<PublishVerdict, "id" | "version" | "packageSha256" | "hasEvals">,
): QualityDecision {
  if (scores === undefined || !v.hasEvals) return { ok: true };
  const raw = scores.get(`${v.id}@${v.version}`);
  if (raw === undefined) {
    return {
      ok: false,
      reason: "it has eval suites and scores.json has no score for it; not signed without a score",
    };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: MALFORMED };
  const keys = Object.keys(raw).sort(codeUnitCompare).join(",");
  if (keys !== "packageSha256,quality" && keys !== "error,packageSha256") {
    return { ok: false, reason: MALFORMED };
  }
  if (raw["packageSha256"] !== v.packageSha256) {
    return {
      ok: false,
      reason: "its scores.json entry is for another package (packageSha256 differs); not signed",
    };
  }
  if (Object.hasOwn(raw, "error")) {
    return {
      ok: false,
      reason: `its eval failed (${failedCode(raw["error"])}); not signed without a score`,
    };
  }
  try {
    return { ok: true, quality: parseEvalQuality(raw["quality"]) };
  } catch (e) {
    return { ok: false, reason: `its score is invalid: ${errorText(e)}; not signed` };
  }
}

interface Attempt {
  /** The commit to push, or `undefined` when `gh-pages` already holds this site. */
  commit: string | undefined;
  added: Added[];
  /** Ids of the publisher statements this run admitted into the index. */
  statements: string[];
  skipped: Skipped[];
  sequence: number;
}

/** Provenance results by package digest: a push-race retry never asks `gh` twice. */
type ProvenanceMemo = Map<string, ProvenanceResult>;

/**
 * The provenance to record for a version this run adds (spec G8): only when its manifest declares
 * a repository, verified over the very package bytes the entry hashes. Never blocks: a failure is
 * one warning and no `provenance`.
 */
async function provenanceFor(
  v: { id: string; version: string; repository?: string; packageSha256: string },
  packageBytes: Uint8Array,
  at: { work: string; verifiedAt: string },
  deps: { io: ActionIo; verify: VerifyPackage },
  memo: ProvenanceMemo,
): Promise<VersionProvenance | undefined> {
  if (v.repository === undefined) return undefined;
  let r = memo.get(v.packageSha256);
  if (r === undefined) {
    r = await verifyNeverThrowing(deps.verify, {
      pkgPath: join(at.work, `provenance-${v.packageSha256}.tgz`),
      packageBytes,
      repository: v.repository,
      verifiedAt: at.verifiedAt,
    });
    memo.set(v.packageSha256, r);
    if (!r.ok) {
      deps.io.annotate(
        "warning",
        `no provenance for ${v.id}@${v.version} (repository ${v.repository}): ${r.reason}; signed without it`,
      );
    }
  }
  // A memo hit from an earlier attempt is re-stamped with THIS attempt's commit time.
  return r.ok ? { ...r.provenance, verifiedAt: at.verifiedAt } : undefined;
}

/** What every attempt of one run shares. */
interface SignRun {
  seed: Uint8Array;
  /** The root key's public half, base64. */
  rootKey: string;
  memo: ProvenanceMemo;
  /** The `scores` input, read once for the run; `undefined` without the input. */
  scores: Scores | undefined;
}

/** What one attempt accumulates while it takes candidates. */
interface Batch {
  extensions: Record<string, RegistryExtensionEntry>;
  files: SiteFile[];
  added: Added[];
  skipped: Skipped[];
  publishedAt: string;
  work: string;
}

/**
 * Take one validated candidate into the batch: skipped when its eval score does not qualify it
 * (and then NOT added to the bindings, so a later candidate cannot bind to it), otherwise added
 * with its provenance and quality.
 */
async function takeCandidate(
  o: Extract<CandidateOutcome, { kind: "valid" }>,
  b: Batch,
  run: SignRun,
  opts: SignOptions,
  deps: SignDeps,
): Promise<void> {
  const { candidate, verdict: v } = o;
  const q = qualityFor(run.scores, v);
  if (!q.ok) {
    b.skipped.push({ dir: o.dir, reason: q.reason });
    return;
  }
  const base = `extensions/${v.id}/${v.version}`;
  const provenance = await provenanceFor(
    v,
    candidate.packageBytes,
    { work: b.work, verifiedAt: b.publishedAt },
    { io: deps.io, verify: deps.provenance ?? ghProvenance(opts.githubToken ?? "") },
    run.memo,
  );
  addVersion(b.extensions, v, b.publishedAt, provenance, q.quality);
  b.files.push(
    { path: `${base}/manifest.json`, bytes: candidate.manifestBytes },
    { path: `${base}/package.tgz`, bytes: candidate.packageBytes },
  );
  b.added.push({
    id: v.id,
    version: v.version,
    channel: v.channel,
    ...(q.quality !== undefined && { quality: q.quality }),
  });
}

/** One attempt, from a fresh fetch to a commit ready to push. Throws on any refusal. */
async function attemptSign(
  opts: SignOptions & { defaultBranch: string },
  run: SignRun,
  deps: SignDeps,
): Promise<Attempt> {
  const { seed, rootKey } = run;
  const { git } = deps;
  const cwd = opts.workspace;
  const mainRef = `origin/${opts.defaultBranch}`;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });

  const index = await readVerifiedIndex(git, cwd);
  if (index.rootKey !== rootKey) {
    throw new Error(
      `refusing to sign: the root-key input (public key fingerprint ${publisherKeyFingerprint(rootKey)}) is not this registry's root key (fingerprint ${publisherKeyFingerprint(index.rootKey)})`,
    );
  }

  const config = readConfigAt(git, mainRef, cwd);
  if (config === undefined) {
    throw new Error(`refusing to sign: ${opts.defaultBranch} has no ${CONFIG_FILE}`);
  }
  const pagesConfig = readConfigAt(git, PAGES_REF, cwd);
  if (pagesConfig !== undefined && loosens(pagesConfig.config, config.config)) {
    throw new Error(
      `refusing to sign: ${opts.defaultBranch}'s ${CONFIG_FILE} loosens the rules the last signed run used (requirePublisherNamespace true -> false); loosening is a maintainer action done by hand`,
    );
  }

  const { dirs, paths } = extensionDirs(git, mainRef, cwd);
  const signedDirs = assertSignedIntact(git, index, mainRef, paths, cwd, "sign");

  // Statements first: a rotation and the first version signed by the new key land together.
  const skipped: Skipped[] = [];
  const admission = admitStatements(git, index, mainRef, cwd, skipped);
  const extensions: Record<string, RegistryExtensionEntry> = { ...index.extensions };
  const publishedAt = git.commitTime(mainRef, { cwd });
  const added: Added[] = [];
  const files: SiteFile[] = [{ path: CONFIG_FILE, bytes: config.bytes }];
  const work = mkdtempSync(join(deps.tmpdir(), "nimbus-registry-sign-"));
  const batch: Batch = { extensions, files, added, skipped, publishedAt, work };
  try {
    for await (const o of validateUnsigned({
      git,
      validate: deps.validate,
      ref: mainRef,
      cwd,
      dirs,
      signedDirs,
      config: config.config,
      work,
      bindings: () => ({ ...admission.index, extensions }),
    })) {
      if (o.kind === "skipped") {
        skipped.push({ dir: o.dir, reason: o.reason });
        continue;
      }
      // NOSONAR S9382: sequential by design - one gh call at a time, inside the same sequential loop as validate
      await takeCandidate(o, batch, run, opts, deps);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // After the extension loop, so a takedown may target an id this very run adds.
  const requested = await signRequests(
    git,
    { ...admission.index, extensions },
    { ref: mainRef, cwd, seed, issuedAt: publishedAt },
    skipped,
  );
  const reportUrl = reportUrlFor(index, opts.repository);
  const statements = [...admission.admitted, ...requested].map(trustStatementId);
  let sequence = index.sequence;
  if (added.length > 0 || statements.length > 0 || reportUrl !== undefined) {
    // Carry every field this action does not manage (e.g. `packs`) through: rebuilding the index
    // from a fixed field list would drop them under a signature that still verifies. The admitted
    // index carries the statements, old and new.
    const { signature: _previousSignature, ...carried } = admission.index;
    const priorStatements = Array.isArray(carried.statements) ? carried.statements : [];
    const signed = await deps.sign(
      {
        ...carried,
        ...(requested.length > 0 && { statements: [...priorStatements, ...requested] }),
        ...(reportUrl !== undefined && { reportUrl }),
        format: 1,
        sequence: index.sequence + 1,
        generatedAt: new Date().toISOString(),
        extensions,
      },
      seed,
    );
    // What a client will do first: verify it against the root key it pinned.
    await verifyRegistryIndexPinned(signed, rootKey);
    sequence = signed.sequence;
    files.push({
      path: INDEX_FILE,
      bytes: new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}\n`),
    });
  }
  const parent = git.commitOf(PAGES_REF, { cwd });
  const message = commitMessage(added, statements, sequence, opts.defaultBranch);
  return {
    commit: commitSite(parent, files, message, cwd),
    added,
    statements,
    skipped,
    sequence,
  };
}

/**
 * Signs each maintainer request on `ref` whose block the index does not already carry (by meaning,
 * against statements verifying under the index's own root), with the registry root seed. Invalid
 * requests land in `skipped`; a request signed earlier, or a renamed copy of one, adds nothing.
 */
async function signRequests(
  git: typeof gitTree,
  index: RegistryIndex,
  at: { ref: string; cwd: string; seed: Uint8Array; issuedAt: string },
  skipped: Skipped[],
): Promise<TrustStatement[]> {
  const files = readRequestFiles(git, at.ref, at.cwd);
  for (const f of files.skipped) skipped.push({ dir: f.path, reason: f.reason });
  const signed: TrustStatement[] = [];
  let current: RegistryIndex = index;
  for (const f of [...files.requests].sort((a, b) => codeUnitCompare(a.name, b.name))) {
    if (alreadyCarried(current, f.request)) continue;
    try {
      // NOSONAR S9382: sequential by design - each request is checked against the ones signed before it
      const s = await signRegistryRequest(f.request, current, at.seed, at.issuedAt);
      signed.push(s);
      const prior = Array.isArray(current.statements) ? current.statements : [];
      current = { ...current, statements: [...prior, s] };
    } catch (e) {
      if (!(e instanceof RegistryError)) throw e;
      skipped.push({ dir: f.path, reason: e.message });
    }
  }
  return signed;
}

/** The report URL to set: this repository's issue form, only when the index has none yet. */
function reportUrlFor(index: RegistryIndex, repository: string | undefined): string | undefined {
  if (repository === undefined || readRegistryReportUrl(index) !== undefined) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository)) return undefined;
  return `https://github.com/${repository}/issues/new`;
}

function commitMessage(
  added: readonly Added[],
  statements: readonly string[],
  sequence: number,
  defaultBranch: string,
): string {
  if (added.length === 0 && statements.length === 0) {
    return `Copy ${CONFIG_FILE} from ${defaultBranch}`;
  }
  const parts = [
    ...added.map(versionRef),
    ...statements.map((id) => `statement ${id.slice(0, 12)}`),
  ];
  return `Sign ${parts.join(", ")} (sequence ${String(sequence)})`;
}

/** `<id>@<version>`. */
function versionRef(x: { id: string; version: string }): string {
  return `${x.id}@${x.version}`;
}

/** `, quality N/100 (…)` for a version signed with a quality; empty otherwise. */
function qualityNote(x: Added): string {
  if (x.quality === undefined) return "";
  const q = x.quality;
  return `, quality ${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`;
}

function report(io: ActionIo, a: Attempt, pushed: boolean): void {
  warnSkipped(io, a);
  const lines = ["## Registry sign", ""];
  if (a.added.length === 0 && a.statements.length === 0) {
    lines.push("Nothing new to sign.");
  } else {
    lines.push(`Signed index sequence ${String(a.sequence)}:`, "");
    for (const x of a.added) lines.push(`- ${code(versionRef(x))} (${x.channel})${qualityNote(x)}`);
    for (const id of a.statements) lines.push(`- statement ${code(id)}`);
  }
  if (a.skipped.length > 0) {
    lines.push(
      "",
      "**Skipped** (not signed; fix the directory or statement file and it is signed on a later run):",
      "",
    );
    for (const s of a.skipped) lines.push(`- ${code(s.dir)}: ${code(s.reason)}`);
  }
  lines.push("", pushed ? `Pushed to ${code(PAGES_BRANCH)}.` : "No change: nothing was committed.");
  io.summary(lines.join("\n"));
  io.log(
    pushed
      ? `signed ${String(a.added.length)} version(s) and ${String(a.statements.length)} statement(s), skipped ${String(a.skipped.length)}; pushed ${PAGES_BRANCH}`
      : `nothing to sign; skipped ${String(a.skipped.length)}; no commit`,
  );
}

function warnSkipped(io: ActionIo, a: Attempt): void {
  for (const s of a.skipped) io.annotate("warning", `skipped ${s.dir}: ${s.reason}`);
}

async function signLoop(
  opts: SignOptions,
  seed: Uint8Array,
  scores: Scores | undefined,
  deps: SignDeps,
): Promise<void> {
  const rootKey = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  let last: Attempt | undefined;
  const run: SignRun = { seed, rootKey, memo: new Map(), scores };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last = await attemptSign({ ...opts, defaultBranch }, run, deps);
      if (last.commit === undefined) {
        report(deps.io, last, false);
        return;
      }
      await deps.beforePush?.(attempt);
      if (pushCommit(last.commit, PAGES_BRANCH, opts.workspace) === "pushed") {
        report(deps.io, last, true);
        return;
      }
      deps.io.log(`${PAGES_BRANCH} moved during attempt ${String(attempt)}; starting over`);
    }
  } catch (e) {
    // A dir this run skipped is still worth naming when the run itself then fails.
    if (last !== undefined) warnSkipped(deps.io, last);
    throw e;
  }
  warnSkipped(deps.io, last as Attempt);
  throw new Error(
    `refusing to continue: the push to ${PAGES_BRANCH} lost to a concurrent update ${String(MAX_ATTEMPTS)} times`,
  );
}

/** Run the `sign` mode. Throws (failing the run, nothing pushed) on any refusal. */
export async function runSign(opts: SignOptions, deps: SignDeps = SHARED): Promise<void> {
  const seed = parseRootKey(opts.rootKey);
  try {
    // Read once, before anything is fetched: every attempt of this run signs the same scores.
    const scores = opts.scores === undefined ? undefined : readScores(opts.scores);
    await signLoop(opts, seed, scores, deps);
  } finally {
    seed.fill(0);
  }
}

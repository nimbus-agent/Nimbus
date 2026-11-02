/**
 * `mode: liveness-sign` — the signing half of a registry's liveness producer. It holds ONE secret,
 * the registry's liveness key, and signs `liveness.json` from a results file the keyless
 * `liveness-check` job wrote. It never touches `index.json`, and it never runs extension code.
 *
 * The results file is untrusted: a compromised check job wrote it. So it is read strictly
 * (`readLivenessResults`): the envelope must be exact and its `nimbusVersion` must be the one this
 * job was told, and every entry is re-parsed with the format's own parser, must be fresh, and must
 * be for the newest stable version of an extension the signed index lists. A bad entry is dropped
 * with a warning; a bad envelope refuses the run. Only this run's entries are signed - the previous
 * file is read for its sequence alone.
 *
 * Every attempt starts from a fresh fetch of `gh-pages`, and refuses - nothing committed - when the
 * index names no liveness key, the `liveness-key` input is not that key, or it is the root key. A
 * push that loses a race starts over, at most `MAX_ATTEMPTS` times. The key is parsed in memory only
 * and zeroed afterwards (best-effort: the decoded Buffer may be pooled and the input string is
 * immutable, so copies can outlive the zeroing - the mask and the scoped
 * environment are the defence); refusals name fingerprints of PUBLIC keys. `main.ts` masks the
 * input and drops it from the environment first.
 */
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import {
  canonicalKeyBytes,
  LIVENESS_FILE,
  type LivenessEntry,
  type LivenessFile,
  NIMBUS_VERSION_RE,
  parseLivenessEntry,
  parseLivenessFile,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  readRegistryLivenessKey,
  sameKeyBytes,
  signLivenessFile,
  verifyLivenessFile,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import { type LivenessResults, newestStableVersions } from "./liveness-check.ts";
import { PAGES_BRANCH, PAGES_REF, readVerifiedIndex } from "./registry-state.ts";
import { type ActionIo, code, GHA_IO } from "./report.ts";
import { commitSite, pushCommit } from "./site-commit.ts";

export const MAX_LIVENESS_RESULTS_BYTES = 4 * 1024 * 1024;
export const RESULTS_MAX_AGE_MS = 24 * 3_600_000;
export const RESULTS_MAX_SKEW_MS = 5 * 60_000;

export interface LivenessSignOptions {
  workspace: string;
  /** The `liveness-key` input: base64 of the 32-byte Ed25519 seed. */
  livenessKey: string;
  /** The default branch; asked of `origin` when absent. */
  defaultBranch?: string;
  /** The results file `liveness-check` wrote (an absolute path). */
  results: string;
  /** The `nimbus-version` input; the results file must name exactly this. */
  nimbusVersion: string;
}

export interface LivenessSignDeps {
  git: typeof gitTree;
  io: ActionIo;
  now: () => number;
  /** Called between building the commit and pushing it; tests race a concurrent push here. */
  beforePush?: (attempt: number) => void | Promise<void>;
}

const SHARED: LivenessSignDeps = { git: gitTree, io: GHA_IO, now: Date.now };

const MAX_ATTEMPTS = 3;

const KEY_INPUT_RE = /^[A-Za-z0-9+/]{43}=$/;
const ENTRY_KEY_RE = /^(.+)@([^@]+)$/;
const ENVELOPE_KEYS: ReadonlySet<string> = new Set(["format", "nimbusVersion", "extensions"]);

function parseLivenessKey(raw: string): Uint8Array {
  const s = raw.trim();
  if (!KEY_INPUT_RE.test(s)) {
    throw new Error(
      'input "liveness-key" is not a liveness signing key: expected the base64 of a 32-byte Ed25519 seed',
    );
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The entry when it may be signed, or its problem as text for the warning. */
function entryProblem(key: string, raw: unknown, now: number): LivenessEntry | string {
  if (!ENTRY_KEY_RE.test(key)) return "its key is not <id>@<version>";
  let entry: LivenessEntry;
  try {
    entry = parseLivenessEntry(raw);
  } catch {
    return "it is not a valid liveness entry";
  }
  const at = Date.parse(entry.checkedAt);
  if (at > now + RESULTS_MAX_SKEW_MS) return "its checkedAt is in the future";
  if (at < now - RESULTS_MAX_AGE_MS) return "its checkedAt is more than 24 hours old";
  return entry;
}

/**
 * The file's bytes through ONE open descriptor: the size checked is the size of the file read, so a
 * file swapped between a check and a read cannot slip past the cap. The bytes read are checked too.
 */
function readCappedFile(path: string, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > max) {
      throw new Error(
        `refusing the results file: ${String(size)} bytes exceeds the ${String(max)} byte limit`,
      );
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > max) {
      throw new Error(`refusing the results file: it grew past the ${String(max)} byte limit`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** The results file's envelope, strictly; the entries are still raw. */
function readEnvelope(
  path: string,
  expectedVersion: string,
): { nimbusVersion: string; raw: Record<string, unknown> } {
  const bytes = readCappedFile(path, MAX_LIVENESS_RESULTS_BYTES);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("refusing the results file: it is not valid UTF-8");
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("refusing the results file: it is not valid JSON");
  }
  if (!isPlainObject(doc) || !Object.keys(doc).every((k) => ENVELOPE_KEYS.has(k))) {
    throw new Error(
      "refusing the results file: it is not an object of exactly format, nimbusVersion and extensions",
    );
  }
  if (doc["format"] !== 1) throw new Error("refusing the results file: format must be 1");
  const version = doc["nimbusVersion"];
  if (typeof version !== "string" || !NIMBUS_VERSION_RE.test(version)) {
    throw new Error("refusing the results file: nimbusVersion is not a Nimbus release number");
  }
  if (version !== expectedVersion) {
    throw new Error(
      `refusing the results file: it was produced for Nimbus ${code(version)}, not the ${code(expectedVersion)} this job was told`,
    );
  }
  const raw = doc["extensions"];
  if (!isPlainObject(raw)) {
    throw new Error("refusing the results file: extensions is not an object");
  }
  return { nimbusVersion: version, raw };
}

/**
 * The results file, strictly. Throws on a bad envelope (size, UTF-8, JSON, exact keys, format, a
 * `nimbusVersion` that is malformed or not `expectedVersion`); drops each bad entry with a warning.
 * The returned map has a null prototype and only own keys.
 */
export function readLivenessResults(
  path: string,
  now: number,
  expectedVersion: string,
  io: ActionIo = GHA_IO,
): LivenessResults {
  const { nimbusVersion, raw } = readEnvelope(path, expectedVersion);
  const extensions: Record<string, LivenessEntry> = Object.create(null) as Record<
    string,
    LivenessEntry
  >;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(raw, key)) continue;
    const r = entryProblem(key, raw[key], now);
    if (typeof r === "string") {
      io.annotate("warning", `dropped results entry ${code(key)}: ${r}`);
    } else {
      extensions[key] = r;
    }
  }
  return { format: 1, nimbusVersion, extensions };
}

interface Attempt {
  /** Results entries that passed validation, before the newest-stable filter. */
  checked: number;
  commit: string | undefined;
  sequence: number;
  kept: number;
}

/** The previous file's sequence, or 0 when there is none or it does not parse. Its entries are never reused. */
async function previousSequence(
  git: typeof gitTree,
  cwd: string,
  indexKey: string,
  io: ActionIo,
): Promise<number> {
  if (
    !git.listTreeEntries(PAGES_REF, LIVENESS_FILE, { cwd }).some((e) => e.path === LIVENESS_FILE)
  ) {
    return 0;
  }
  let prev: LivenessFile;
  try {
    prev = parseLivenessFile(git.readBlob(PAGES_REF, LIVENESS_FILE, { cwd }));
  } catch {
    io.annotate("warning", `the previous ${LIVENESS_FILE} does not parse; starting at sequence 1`);
    return 0;
  }
  try {
    await verifyLivenessFile(prev, indexKey);
  } catch {
    io.log(
      `the previous ${LIVENESS_FILE} does not verify against the index key; its entries are not reused`,
    );
  }
  return prev.sequence;
}

/**
 * Re-reads exactly the bytes about to be committed with the client's own parser (size cap included)
 * and verifies them: a file the client would refuse must never reach `gh-pages`.
 */
export async function verifyCommittedBytes(bytes: Uint8Array, indexKey: string): Promise<void> {
  await verifyLivenessFile(parseLivenessFile(bytes), indexKey);
}

async function attemptSign(
  opts: LivenessSignOptions & { defaultBranch: string },
  seed: Uint8Array,
  ownKey: string,
  deps: LivenessSignDeps,
): Promise<Attempt> {
  const cwd = opts.workspace;
  const { git, io } = deps;
  git.fetchRefs([opts.defaultBranch, PAGES_BRANCH], { cwd });
  const index = await readVerifiedIndex(git, cwd);
  const indexKey = readRegistryLivenessKey(index);
  if (indexKey === undefined) {
    throw new Error(
      "refusing to sign: this registry's index names no liveness key; run `nimbus registry maintain set-liveness-key`",
    );
  }
  if (indexKey === "invalid") {
    throw new Error("refusing to sign: this registry's index names a malformed liveness key");
  }
  if (!sameKeyBytes(indexKey, ownKey)) {
    throw new Error(
      `refusing to sign: the liveness-key input (public key fingerprint ${publisherKeyFingerprint(ownKey)}) is not this registry's liveness key (fingerprint ${publisherKeyFingerprint(indexKey)})`,
    );
  }
  if (canonicalKeyBytes(index.rootKey) === undefined) {
    throw new Error("refusing to sign: this registry's index names a malformed root key");
  }
  if (sameKeyBytes(indexKey, index.rootKey)) {
    throw new Error(
      `refusing to sign: the liveness key (fingerprint ${publisherKeyFingerprint(indexKey)}) is this registry's root key; the two must be different keys`,
    );
  }
  const read = readLivenessResults(opts.results, deps.now(), opts.nimbusVersion, io);
  const allowed = new Set(newestStableVersions(index).map((e) => `${e.id}@${e.version}`));
  const extensions: Record<string, LivenessEntry> = {};
  for (const key of Object.keys(read.extensions)) {
    const entry = read.extensions[key];
    if (entry === undefined) continue;
    if (allowed.has(key)) {
      extensions[key] = entry;
    } else {
      io.annotate(
        "warning",
        `dropped results entry ${code(key)}: it is not the newest stable version of a listed extension`,
      );
    }
  }
  const checked = Object.keys(read.extensions).length;
  const kept = Object.keys(extensions).length;
  if (kept === 0) return { commit: undefined, sequence: 0, kept, checked };
  const sequence = (await previousSequence(git, cwd, indexKey, io)) + 1;
  const signed = await signLivenessFile(
    {
      format: 1,
      livenessKey: indexKey,
      sequence,
      generatedAt: new Date(deps.now()).toISOString(),
      nimbusVersion: read.nimbusVersion,
      extensions,
    },
    seed,
  );
  const bytes = new TextEncoder().encode(`${JSON.stringify(signed, null, 2)}\n`);
  await verifyCommittedBytes(bytes, indexKey);
  const commit = commitSite(
    git.commitOf(PAGES_REF, { cwd }),
    [{ path: LIVENESS_FILE, bytes }],
    `Publish liveness.json sequence ${String(sequence)}`,
    cwd,
  );
  return { commit, sequence, kept, checked };
}

function report(io: ActionIo, a: Attempt, pushed: boolean): void {
  const head = pushed
    ? `Signed ${code(LIVENESS_FILE)} sequence ${String(a.sequence)} with ${String(a.kept)} entries; pushed to ${code(PAGES_BRANCH)}.`
    : "There is nothing to publish: no results entry was fit to sign, so nothing was committed.";
  if (!pushed) {
    io.annotate(
      "warning",
      `liveness-sign published nothing: ${String(a.checked)} results entries passed validation and ${String(a.kept)} were for a newest stable version; check the liveness-check job`,
    );
  }
  io.summary(["## Liveness sign", "", head].join("\n"));
  io.log(
    pushed ? `signed liveness sequence ${String(a.sequence)}` : "nothing to publish; no commit",
  );
}

async function signLoop(
  opts: LivenessSignOptions,
  seed: Uint8Array,
  deps: LivenessSignDeps,
): Promise<void> {
  const ownKey = Buffer.from(publicKeyFromSeed(seed)).toString("base64");
  const defaultBranch = opts.defaultBranch ?? deps.git.remoteDefaultBranch({ cwd: opts.workspace });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // NOSONAR S9382: sequential by design - each attempt starts from a fresh fetch after a lost race
    const a = await attemptSign({ ...opts, defaultBranch }, seed, ownKey, deps);
    if (a.commit === undefined) {
      report(deps.io, a, false);
      return;
    }
    await deps.beforePush?.(attempt);
    if (pushCommit(a.commit, PAGES_BRANCH, opts.workspace) === "pushed") {
      report(deps.io, a, true);
      return;
    }
    deps.io.log(`${PAGES_BRANCH} moved during attempt ${String(attempt)}; starting over`);
  }
  throw new Error(
    `refusing to continue: the push to ${PAGES_BRANCH} lost to a concurrent update ${String(MAX_ATTEMPTS)} times`,
  );
}

/** Run the `liveness-sign` mode. Throws (failing the run, nothing pushed) on any refusal. */
export async function runLivenessSign(
  opts: LivenessSignOptions,
  deps: LivenessSignDeps = SHARED,
): Promise<void> {
  const seed = parseLivenessKey(opts.livenessKey);
  try {
    await signLoop(opts, seed, deps);
  } finally {
    seed.fill(0);
  }
}

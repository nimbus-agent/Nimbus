import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  alreadyCarried,
  canonicalKeyBytes,
  emptyIndex,
  judgeScoreEntry,
  type PublishVerdict,
  packExtensionDir,
  parseRegistryConfig,
  publicKeyFromSeed,
  publisherAfterPublish,
  publisherKeyFingerprint,
  type RegistryConfig,
  RegistryError,
  type RegistryIndex,
  type RegistryRequest,
  readScores,
  type ScoreDecision,
  type Scores,
  signIndex,
  signRegistryRequest,
  trustStatementId,
  validatePublish,
  verifyIndexSignature,
} from "@nimbus-dev/registry-format";
import { encodeBase64, generateEd25519Keypair } from "../lib/extension-signing.ts";
import {
  DEFAULT_BUILD,
  DEFAULT_IO,
  httpsUrl,
  isSameOrInside,
  loadSeed,
  type MaintainBuild,
  MaintainError,
  type MaintainIo,
  type ParsedArgs,
  parseArgs,
  requestFrom,
  resolveActionPin,
  resolveDefaultBranch,
  SITE_FILES,
  splitIdVersion,
  writeKeyFile,
  writeRequestJson,
  writeRootKey,
} from "../lib/maintain-shared.ts";
import { buildPublishCandidate, DEFAULT_REGISTRY_CONFIG } from "../lib/publish-candidate.ts";
import { readIndexFile, writeIndexAtomic } from "../lib/registry-index.ts";
import { admitAllStatements, readStatementArgs } from "../lib/statement-files.ts";
import { stripControlChars } from "../lib/strip-control-chars.ts";

export type { MaintainBuild, MaintainIo } from "../lib/maintain-shared.ts";

import { ownerNextSteps, registryReadme } from "./registry-templates/readme.ts";
import {
  type ActionPin,
  registryCheckWorkflow,
  registryLivenessWorkflow,
  registrySignWorkflow,
} from "./registry-templates/workflows.ts";

const USAGE =
  "Usage: nimbus registry maintain init <dir> [--key <path>] [--force] [--report-url <https url>] [--github [--liveness-key <path>] [--action-ref <40-hex>] [--site <path>] [--default-branch <name>] [--no-publisher-namespace]] | add <dir> <package.tgz|extension-dir> [--channel stable|beta] [--statement <file>]... [--scores <scores.json>] [--key <path>] | remove <dir> <id>[@<version>] [--key <path>] | revoke-key (<dir> | --github <clone>) <fingerprint> --publisher <id> --reason <text> [--key <path>] | takedown (<dir> | --github <clone>) <id>[@<version>] --reason <text> [--publisher <id>] [--key <path>] | set-report-url <dir> <https url> [--key <path>] | set-liveness-key <dir> (<public key> | --generate [--liveness-key <path>] [--force]) [--key <path>] (--generate: keep the key file outside every clone of the registry repo)\n";

function keyPathOf(p: ParsedArgs): string {
  return p.options.get("--key") ?? join(homedir(), ".nimbus", "registry-key");
}

function livenessKeyPathOf(p: ParsedArgs): string {
  return p.options.get("--liveness-key") ?? join(homedir(), ".nimbus", "registry-liveness-key");
}

/** Read the folder's index and require it to be signed by THIS key before anything is changed. */
function loadOwnedIndex(dir: string, seed: Uint8Array): RegistryIndex {
  const path = join(dir, "index.json");
  if (!existsSync(path)) throw new MaintainError(`${path} not found; run \`maintain init\` first`);
  const index = readIndexFile(path);
  if (index.rootKey !== encodeBase64(publicKeyFromSeed(seed))) {
    throw new MaintainError("this registry is signed by a different key than --key");
  }
  if (!verifyIndexSignature(index)) {
    throw new MaintainError("the existing index.json does not verify");
  }
  return index;
}

async function resign(
  dir: string,
  seed: Uint8Array,
  prev: RegistryIndex,
  extensions: RegistryIndex["extensions"],
  fields: { statements?: unknown[]; reportUrl?: string; livenessKey?: string } = {},
): Promise<RegistryIndex> {
  // Carry every field this command does not manage (e.g. `packs`) through: rebuilding the index
  // from a fixed field list would drop them under a signature that still verifies.
  const { signature: _previousSignature, ...carried } = prev;
  const next = await signIndex(
    {
      ...carried,
      ...fields,
      format: 1,
      sequence: prev.sequence + 1,
      generatedAt: new Date().toISOString(),
      extensions,
    },
    seed,
  );
  writeIndexAtomic(dir, next);
  return next;
}

/** Options that only mean something with `--github`. */
const GITHUB_ONLY = [
  "--liveness-key",
  "--action-ref",
  "--site",
  "--default-branch",
  "--no-publisher-namespace",
] as const;

/** Everything `init --github` will write, decided and checked before the key is generated. */
interface GithubPlan {
  pin: ActionPin;
  site: string;
  defaultBranch: string;
  /** Where the liveness private key goes: outside both folders, and not the root key's file. */
  livenessKeyPath: string;
  /** Main-branch files, relative to `<dir>` (`/`-separated), with their contents. */
  mainFiles: ReadonlyArray<readonly [string, string]>;
  configText: string;
}

/** The liveness key's file, refused when it could be pushed to GitHub or would clobber another key. */
function assertLivenessKeyPath(
  p: ParsedArgs,
  dir: string,
  site: string,
  keyPath: string,
  force: boolean,
): string {
  const livenessKeyPath = livenessKeyPathOf(p);
  for (const folder of [dir, site]) {
    if (isSameOrInside(livenessKeyPath, folder)) {
      throw new MaintainError(
        `the liveness key ${livenessKeyPath} would be inside ${folder}, which is pushed to GitHub; keep it outside the registry folders (the default is ~/.nimbus/registry-liveness-key)`,
      );
    }
  }
  if (resolve(livenessKeyPath) === resolve(keyPath)) {
    throw new MaintainError(
      `--liveness-key ${livenessKeyPath} is the root key's file; the liveness key must be a different key in a different file`,
    );
  }
  if (!force && existsSync(livenessKeyPath)) {
    throw new MaintainError(`refusing to overwrite ${livenessKeyPath} without --force`);
  }
  return livenessKeyPath;
}

/** Refuses when any file `init --github` would write already exists (without `--force`). */
function assertTargetsFree(
  dir: string,
  site: string,
  mainFiles: ReadonlyArray<readonly [string, string]>,
): void {
  const targets = [
    ...mainFiles.map(([rel]) => join(dir, ...rel.split("/"))),
    join(site, "index.json"),
    join(site, "nimbus-registry.json"),
    ...SITE_FILES.map(([rel]) => join(site, rel)),
  ];
  const taken = targets.find((t) => existsSync(t));
  if (taken !== undefined) {
    throw new MaintainError(`${taken} exists; refusing to overwrite without --force`);
  }
}

function planGithubInit(
  p: ParsedArgs,
  dir: string,
  keyPath: string,
  build: MaintainBuild,
  force: boolean,
): GithubPlan {
  const pin = resolveActionPin(p, build);
  const defaultBranch = resolveDefaultBranch(p);
  const site = p.options.get("--site") ?? `${resolve(dir)}-site`;
  if (isSameOrInside(site, dir) || isSameOrInside(dir, site)) {
    throw new MaintainError(
      `--site ${site} overlaps ${dir}; the site goes to the gh-pages branch and <dir> to the main branch, so neither folder may hold the other`,
    );
  }
  for (const folder of [dir, site]) {
    if (isSameOrInside(keyPath, folder)) {
      throw new MaintainError(
        `the root key ${keyPath} would be inside ${folder}, which is pushed to GitHub; keep it outside the registry folders (the default is ~/.nimbus/registry-key)`,
      );
    }
  }
  const livenessKeyPath = assertLivenessKeyPath(p, dir, site, keyPath, force);
  if (existsSync(join(dir, "index.json"))) {
    throw new MaintainError(
      `${join(dir, "index.json")} exists; a --github registry's main branch never holds a signed index (it lives on gh-pages): remove it first`,
    );
  }
  const requirePublisherNamespace = !p.flags.has("--no-publisher-namespace");
  const configText = `${JSON.stringify({ format: 1, requirePublisherNamespace }, null, 2)}\n`;
  const mainFiles: Array<readonly [string, string]> = [
    [".github/workflows/registry-check.yml", registryCheckWorkflow(pin, defaultBranch)],
    [".github/workflows/registry-liveness.yml", registryLivenessWorkflow(pin, defaultBranch)],
    [".github/workflows/registry-sign.yml", registrySignWorkflow(pin, defaultBranch)],
    ["nimbus-registry.json", configText],
    ["README.md", registryReadme({ requirePublisherNamespace, defaultBranch })],
    ["extensions/.gitkeep", ""],
    // Package bytes are hashed and signed: git must never rewrite their line endings.
    ["extensions/.gitattributes", "* -text\n"],
  ];
  if (!force) assertTargetsFree(dir, site, mainFiles);
  return { pin, site, defaultBranch, livenessKeyPath, mainFiles, configText };
}

function writeGithubRegistry(dir: string, plan: GithubPlan, index: RegistryIndex): void {
  for (const [rel, text] of plan.mainFiles) {
    const path = join(dir, ...rel.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  mkdirSync(plan.site, { recursive: true });
  writeIndexAtomic(plan.site, index);
  writeFileSync(join(plan.site, "nimbus-registry.json"), plan.configText);
  for (const [rel, text] of SITE_FILES) writeFileSync(join(plan.site, rel), text);
}

/** Refuses the flags only `--github` takes, and an existing index, for a plain `init`. */
function assertPlainInit(p: ParsedArgs, dir: string, force: boolean): void {
  const stray = GITHUB_ONLY.find((o) => p.options.has(o) || p.flags.has(o));
  if (stray !== undefined) throw new MaintainError(`${stray} needs --github`);
  if (existsSync(join(dir, "index.json")) && !force) {
    throw new MaintainError(
      `${join(dir, "index.json")} exists; refusing to overwrite without --force`,
    );
  }
}

/** What `init` tells the owner once everything is written. */
function printInitResult(
  io: MaintainIo,
  r: {
    dir: string;
    index: RegistryIndex;
    rootFingerprint: string;
    keyPath: string;
    plan: GithubPlan | undefined;
    livenessFingerprint: string | undefined;
  },
): void {
  const { dir, index, rootFingerprint, keyPath, plan, livenessFingerprint } = r;
  if (plan === undefined) {
    io.stdout(`registry initialised in ${dir} (sequence 1)\n`);
  } else {
    io.stdout(`registry repository written to ${dir} (push it to main)\n`);
    io.stdout(`initial site written to ${plan.site} (sequence 1; push it as gh-pages)\n`);
  }
  io.stdout(`root key:    ${index.rootKey}\n`);
  io.stdout(`fingerprint: ${rootFingerprint}\n`);
  io.stdout(`key file:    ${keyPath} (keep it secret and backed up)\n`);
  if (plan !== undefined && livenessFingerprint !== undefined) {
    io.stdout(
      `liveness fingerprint: ${livenessFingerprint}\n` +
        `liveness key file:    ${plan.livenessKeyPath} (keep it secret and backed up)\n`,
    );
    io.stdout(`action pin:  ${plan.pin.commit} (Nimbus v${plan.pin.version})\n`);
    io.stdout("\n");
    io.stdout(
      ownerNextSteps({
        dir,
        site: plan.site,
        keyPath,
        livenessKeyPath: plan.livenessKeyPath,
        defaultBranch: plan.defaultBranch,
      }),
    );
  }
}

async function maintainInit(args: string[], io: MaintainIo, build: MaintainBuild): Promise<void> {
  const p = parseArgs(
    args,
    ["--key", "--liveness-key", "--action-ref", "--site", "--default-branch", "--report-url"],
    ["--force", "--github", "--no-publisher-namespace"],
  );
  const reportUrlOpt = p.options.get("--report-url");
  const reportUrl = reportUrlOpt === undefined ? undefined : httpsUrl(reportUrlOpt, "--report-url");
  const dir = p.positional[0];
  if (dir === undefined || p.positional.length !== 1) throw new MaintainError("init needs <dir>");
  const force = p.flags.has("--force");
  const keyPath = keyPathOf(p);
  const plan = p.flags.has("--github") ? planGithubInit(p, dir, keyPath, build, force) : undefined;
  if (plan === undefined) assertPlainInit(p, dir, force);
  const { privkey, pubkey } = generateEd25519Keypair();
  writeRootKey(keyPath, privkey, force);
  // Only a --github registry has a scheduled job that signs with a liveness key.
  const liveness = plan === undefined ? undefined : generateEd25519Keypair();
  if (plan !== undefined && liveness !== undefined) {
    writeKeyFile(plan.livenessKeyPath, liveness.privkey, force);
  }
  const index = await signIndex(
    {
      ...emptyIndex(encodeBase64(pubkey)),
      ...(reportUrl === undefined ? {} : { reportUrl }),
      ...(liveness === undefined ? {} : { livenessKey: encodeBase64(liveness.pubkey) }),
    },
    privkey,
  );
  if (plan === undefined) {
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeIndexAtomic(dir, index);
  } else {
    writeGithubRegistry(dir, plan, index);
  }
  printInitResult(io, {
    dir,
    index,
    rootFingerprint: publisherKeyFingerprint(encodeBase64(pubkey)),
    keyPath,
    plan,
    livenessFingerprint:
      liveness === undefined ? undefined : publisherKeyFingerprint(encodeBase64(liveness.pubkey)),
  });
}

/**
 * Opens `source` ONCE and does the type check and the read through that descriptor, so nothing can be
 * swapped between a check and a use of the path. Returns the file's bytes, or `undefined` for a
 * directory (which the packer walks). A symlink is refused where the OS can refuse it at open
 * (`O_NOFOLLOW`, POSIX); Windows has no such flag, and there the source is the maintainer's own local
 * path, so a link is followed.
 */
function readSourceFile(source: string): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new MaintainError(`${source} is a symlink; refusing`);
    if (code === "ENOENT") throw new MaintainError(`${source} does not exist`);
    if ((code === "EISDIR" || code === "EPERM" || code === "EACCES") && isDirectory(source)) {
      return undefined; // Windows cannot open a directory as a file
    }
    throw new MaintainError(`${source} cannot be read`);
  }
  try {
    if (fstatSync(fd).isDirectory()) return undefined;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** `<dir>/nimbus-registry.json` when present; absent means today's rules (no namespace required). */
function readRegistryConfig(dir: string): RegistryConfig {
  const path = join(dir, "nimbus-registry.json");
  if (!existsSync(path)) return DEFAULT_REGISTRY_CONFIG;
  return parseRegistryConfig(readFileSync(path));
}

/** The `--statement` files admitted into `index`; a file it cannot admit refuses the add. */
function admitStatementArgs(index: RegistryIndex, paths: readonly string[]) {
  try {
    return admitAllStatements(index, readStatementArgs(paths));
  } catch (e) {
    throw new MaintainError((e as Error).message);
  }
}

/** One line, with no control character, however hostile the text: for anything from a file. */
function oneSafeLine(text: string): string {
  return stripControlChars(text).replaceAll(/[\u2028\u2029]/g, " ");
}

/**
 * The `--scores` file, read once and before the source package is touched. The file is the owner's
 * input but its content is untrusted, and so is its path in a message: nothing is printed raw.
 */
function readScoresArg(p: ParsedArgs): Scores | undefined {
  const path = p.options.get("--scores");
  if (path === undefined) return undefined;
  try {
    return readScores(path);
  } catch (e) {
    throw new MaintainError(oneSafeLine(e instanceof Error ? e.message : String(e)));
  }
}

/** The version entry `maintain add` signs: the fixed fields, then a score and a baseline if decided. */
function versionEntry(
  v: PublishVerdict,
  rel: string,
  decision: Extract<ScoreDecision, { ok: true }>,
) {
  return {
    channel: v.channel,
    name: v.name,
    manifest: `${rel}/manifest.json`,
    manifestSha256: v.manifestSha256,
    package: `${rel}/package.tgz`,
    packageSha256: v.packageSha256,
    packageSizeBytes: v.packageSizeBytes,
    entryHash: v.entryHash,
    publishedAt: new Date().toISOString(),
    ...(decision.quality === undefined ? {} : { quality: decision.quality }),
    ...(decision.baseline === undefined ? {} : { baseline: decision.baseline }),
  };
}

/** `, quality N/100` and `, baseline passed|failed`, each only when that field was signed. */
function scoreSummary(decision: Extract<ScoreDecision, { ok: true }>): string {
  const quality = decision.quality === undefined ? "" : `, quality ${decision.quality.score}/100`;
  if (decision.baseline === undefined) return quality;
  return `${quality}, baseline ${decision.baseline.passed ? "passed" : "failed"}`;
}

/**
 * What the `--scores` file says about this version, decided before the first write so a refusal
 * leaves the folder untouched. A refusal throws; an ignored baseline is a one-line notice.
 */
function decideScore(
  scores: Scores | undefined,
  v: PublishVerdict,
  io: MaintainIo,
): Extract<ScoreDecision, { ok: true }> {
  const decision = judgeScoreEntry(scores, v);
  if (!decision.ok) {
    throw new MaintainError(
      `refusing to add ${v.id}@${v.version}: ${oneSafeLine(decision.reason)}`,
    );
  }
  if (decision.baselineIgnored !== undefined) {
    io.stdout(`${v.id}@${v.version}: ${oneSafeLine(decision.baselineIgnored)}\n`);
  }
  return decision;
}

async function maintainAdd(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key", "--channel", "--scores"], [], ["--statement"]);
  const [dir, source] = p.positional;
  if (dir === undefined || source === undefined || p.positional.length !== 2) {
    throw new MaintainError("add needs <dir> <package.tgz|extension-dir>");
  }
  const channel = p.options.get("--channel") ?? "stable";
  if (channel !== "stable" && channel !== "beta") {
    throw new MaintainError("--channel must be stable or beta");
  }
  const scores = readScoresArg(p);
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  // Statements first: a rotation and the first version signed by the new key are added together.
  const admission = admitStatementArgs(index, p.lists.get("--statement") ?? []);
  const fileBytes = readSourceFile(source);

  const work = mkdtempSync(join(tmpdir(), "nimbus-registry-add-"));
  try {
    // The package is read ONCE. A file source is copied into the private work dir from that single
    // read; from then on inspection, hashing and the registry copy all use that private copy, never
    // `source` again, so what was validated is exactly what is published.
    const tgz = join(work, "package.tgz");
    if (fileBytes === undefined) {
      await packExtensionDir(source, tgz);
    } else {
      writeFileSync(tgz, fileBytes, { flag: "wx" });
    }
    if (statSync(tgz).size === 0) throw new MaintainError("package size is out of range");
    // The signed index was verified by `loadOwnedIndex` above; the validator trusts it.
    const config = readRegistryConfig(dir);
    const candidate = await buildPublishCandidate(tgz, work, channel);
    const v = await validatePublish(candidate, admission.index, config, work);
    const existing = index.extensions[v.id];

    const decision = decideScore(scores, v, io);

    const rel = `extensions/${v.id}/${v.version}`;
    const destDir = join(dir, "extensions", ...v.id.split("/"), v.version);
    mkdirSync(destDir, { recursive: true });
    writeFileSync(join(destDir, "manifest.json"), candidate.manifestBytes);
    writeFileSync(join(destDir, "package.tgz"), candidate.packageBytes);

    const entry = versionEntry(v, rel, decision);
    const next = await resign(dir, seed, admission.index, {
      ...index.extensions,
      [v.id]: {
        publisher: publisherAfterPublish(existing, v.publisher),
        versions: { ...existing?.versions, [v.version]: entry },
      },
    });
    const statements = admission.admitted.map(
      (s) => ` statement ${trustStatementId(s).slice(0, 12)}`,
    );
    io.stdout(
      `added ${v.id}@${v.version} (${channel})${statements.join(",")}${scoreSummary(decision)}; sequence ${String(next.sequence)}\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

async function maintainRemove(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key"], []);
  const [dir, ref] = p.positional;
  if (dir === undefined || ref === undefined || p.positional.length !== 2) {
    throw new MaintainError("remove needs <dir> <id>[@<version>]");
  }
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  const { id, version } = splitIdVersion(ref);
  const existing = index.extensions[id];
  if (existing === undefined) throw new MaintainError(`${id} is not in this registry`);
  const { [id]: _dropped, ...others } = index.extensions;
  let extensions: RegistryIndex["extensions"] = others;
  if (version !== undefined) {
    if (existing.versions[version] === undefined) {
      throw new MaintainError(`${id}@${version} is not in this registry`);
    }
    const { [version]: _gone, ...left } = existing.versions;
    if (Object.keys(left).length > 0) {
      extensions = { ...others, [id]: { publisher: existing.publisher, versions: left } };
    }
  }
  const next = await resign(dir, seed, index, extensions);
  const what = version === undefined ? id : `${id}@${version}`;
  io.stdout(`removed ${what}; sequence ${String(next.sequence)}\n`);
}

/**
 * `--github <clone>`: the root key lives only in the registry's CI, so the request is written as
 * `trust-requests/<name>.json` for a pull request; the sign job signs it on merge, behind the
 * `registry-signing` environment's approval. No git command runs here.
 */
function writeRequestFile(clone: string, req: RegistryRequest, io: MaintainIo): void {
  const { path, status } = writeRequestJson(clone, "trust-requests", req);
  if (status === "same") {
    io.stdout(`${path} already requested; nothing written\n`);
    return;
  }
  io.stdout(
    `wrote ${path}\n` +
      "Commit it on a branch and open a pull request against the registry. On merge, the sign workflow signs it with the registry root key (after the registry-signing approval) and every client that installed from this registry applies it.\n",
  );
}

async function maintainBlock(
  kind: "key.revoke" | "extension.takedown",
  args: string[],
  io: MaintainIo,
): Promise<void> {
  const p = parseArgs(args, ["--key", "--github", "--publisher", "--reason"], []);
  const github = p.options.get("--github");
  const needed = github === undefined ? 2 : 1;
  if (p.positional.length !== needed) {
    const subject = kind === "key.revoke" ? "<fingerprint>" : "<id>[@<version>]";
    throw new MaintainError(
      `${kind === "key.revoke" ? "revoke-key" : "takedown"} needs (<dir> | --github <clone>) ${subject}`,
    );
  }
  const subject = p.positional[needed - 1] as string;
  const req = requestFrom(kind, p, subject);
  if (github !== undefined) {
    writeRequestFile(github, req, io);
    return;
  }
  const dir = p.positional[0] as string;
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  if (alreadyCarried(index, req)) {
    io.stdout("this registry's index already carries that block; nothing changed\n");
    return;
  }
  const statement = await signRegistryRequest(req, index, seed, new Date().toISOString());
  const existing = Array.isArray(index.statements) ? index.statements : [];
  const next = await resign(dir, seed, index, index.extensions, {
    statements: [...existing, statement],
  });
  io.stdout(`signed ${statement.kind} into the index; sequence ${String(next.sequence)}\n`);
}

async function maintainSetReportUrl(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key"], []);
  const [dir, raw] = p.positional;
  if (dir === undefined || raw === undefined || p.positional.length !== 2) {
    throw new MaintainError("set-report-url needs <dir> <https url>");
  }
  const reportUrl = httpsUrl(raw, "the report URL");
  const seed = loadSeed(keyPathOf(p));
  const index = loadOwnedIndex(dir, seed);
  const next = await resign(dir, seed, index, index.extensions, { reportUrl });
  io.stdout(`report URL set; sequence ${String(next.sequence)}\n`);
}

/** The public key to name, or a fresh pair's (written to `--liveness-key` before anything is signed). */
function livenessKeyArg(p: ParsedArgs, dir: string, rootKeyPath: string, rootKey: string) {
  const given = p.positional[1];
  const generate = p.flags.has("--generate");
  if (p.positional.length !== (generate ? 1 : 2) || generate === (given !== undefined)) {
    throw new MaintainError(
      "set-liveness-key needs <dir> and exactly one of <public key> or --generate",
    );
  }
  if (!generate) {
    if (p.options.has("--liveness-key") || p.flags.has("--force")) {
      throw new MaintainError("--liveness-key and --force go with --generate");
    }
    // Compared as decoded bytes, and before the canonical check, so a non-canonical spelling of
    // the root key is refused as the root key (its padding bits decode away to the same 32 bytes).
    const rootBytes = canonicalKeyBytes(rootKey);
    if (
      rootBytes !== undefined &&
      Buffer.from(rootBytes).equals(Buffer.from(given as string, "base64"))
    ) {
      throw new MaintainError("the liveness key must differ from the registry's root key");
    }
    if (canonicalKeyBytes(given) === undefined) {
      throw new MaintainError(
        "the liveness key must be an Ed25519 public key (canonical base64 of 32 bytes)",
      );
    }
    return { publicKey: given as string };
  }
  const path = livenessKeyPathOf(p);
  if (isSameOrInside(path, dir)) {
    throw new MaintainError(
      `the liveness key ${path} would be inside ${dir}, which is pushed to GitHub; keep it outside the registry folders`,
    );
  }
  if (resolve(path) === resolve(rootKeyPath)) {
    throw new MaintainError(
      `--liveness-key ${path} is the root key's file; the liveness key must be a different key in a different file`,
    );
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  return { publicKey: encodeBase64(pubkey), written: { path, privkey } };
}

async function maintainSetLivenessKey(args: string[], io: MaintainIo): Promise<void> {
  const p = parseArgs(args, ["--key", "--liveness-key"], ["--generate", "--force"]);
  const dir = p.positional[0];
  if (dir === undefined) throw new MaintainError("set-liveness-key needs <dir>");
  const keyPath = keyPathOf(p);
  const seed = loadSeed(keyPath);
  const index = loadOwnedIndex(dir, seed);
  const { publicKey, written } = livenessKeyArg(p, dir, keyPath, index.rootKey);
  // The private key is on disk before the index names its public half: a failure after this
  // leaves an unused key file, never an index naming a key nobody holds.
  if (written !== undefined) writeKeyFile(written.path, written.privkey, p.flags.has("--force"));
  const next = await resign(dir, seed, index, index.extensions, { livenessKey: publicKey });
  io.stdout(`liveness key set; sequence ${String(next.sequence)}\n`);
  io.stdout(`liveness fingerprint: ${publisherKeyFingerprint(publicKey)}\n`);
  if (written !== undefined) {
    io.stdout(`liveness key file:    ${written.path} (keep it secret and backed up)\n`);
    io.stdout(
      "keep that file outside every clone of the registry repository (this command can only check <dir>)\n",
    );
  }
}

export async function runRegistryMaintain(
  args: string[],
  io: MaintainIo = DEFAULT_IO,
  build: MaintainBuild = DEFAULT_BUILD,
): Promise<number> {
  const [sub, ...rest] = args;
  const handlers: Record<
    string,
    (a: string[], io: MaintainIo, build: MaintainBuild) => Promise<void>
  > = {
    init: maintainInit,
    add: maintainAdd,
    remove: maintainRemove,
    "revoke-key": (a, i) => maintainBlock("key.revoke", a, i),
    takedown: (a, i) => maintainBlock("extension.takedown", a, i),
    "set-report-url": maintainSetReportUrl,
    "set-liveness-key": maintainSetLivenessKey,
  };
  const handler = sub === undefined ? undefined : handlers[sub];
  if (handler === undefined) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    await handler(rest, io, build);
    return 0;
  } catch (e) {
    if (e instanceof MaintainError || e instanceof RegistryError) {
      io.stderr(`${e.message}\n`);
      return 2;
    }
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

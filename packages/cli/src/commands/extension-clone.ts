/**
 * `nimbus extension clone <id> [--registry <name>] [--version <v>] [--into <dir>] [--publisher <id>]
 * [--json]`: an editable copy of a published extension. The gateway fetches the package through
 * the verified registry chain (`registry.cloneSource`) and stages it; this command never installs
 * and never touches the network itself. It checks the staged path's shape before touching it,
 * hashes the bytes it read against the reply, unpacks them into a private work directory, copies
 * the package files into `--into`, strips the original publisher's identity (`signature`,
 * `publisher`) and records where the copy came from in `CLONED_FROM.md`.
 *
 * A licence never refuses a clone (owner ruling R6): an absent, malformed or non-OSI licence
 * warns. Every string from the reply or the manifest is printed through `clean`.
 */
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertCanonicalExtensionId,
  assertSafeExtensionId,
  type InspectedPackage,
  inspectPackage,
  nonOsiLicenseIds,
  RegistryError,
  readManifestLicense,
  readManifestRepository,
} from "@nimbus-dev/registry-format";

import type { IPCClient } from "../ipc-client/index.ts";
import { stripControlChars as clean } from "../lib/strip-control-chars.ts";
import { publisherIdProblem, resolveExtensionId } from "./scaffold.ts";

export interface CloneDeps {
  client: IPCClient;
  cwd: string;
  tmpDir: string;
  now: () => Date;
  log: (s: string) => void;
  err: (s: string) => void;
}

const USAGE =
  "Usage: nimbus extension clone <id> [--registry <name>] [--version <v>] [--into <dir>] [--publisher <id>] [--json]\n";

const MANIFEST_FILE = "nimbus.extension.json";
const NOTES_FILE = "CLONED_FROM.md";
const STAGING_ROOT_NAME = "registry-clone-staging";
const STAGE_PREFIX = "c-";
const ARCHIVE_NAME = "package.tgz";
const LICENCE_ADVICE = "make sure the licence lets you modify and redistribute this code.";

const VALUE_FLAGS = new Set(["--registry", "--version", "--into", "--publisher"]);

interface Plan {
  id: string;
  registry?: string;
  version?: string;
  /** Absolute; checked absent (with an existing parent) before any IPC, created by clone. */
  into: string;
  publisher?: string;
  newId?: string;
  json: boolean;
}

interface CloneSource {
  id: string;
  version: string;
  channel: string;
  registry: string;
  publisherId: string;
  keyFingerprint: string;
  verifiedPublisher: { github: string; verifiedAt: string } | null;
  packageSha256: string;
  archivePath: string;
}

interface LicenseView {
  line: string;
  value: string | null;
  warning: string | null;
}

interface CloneResult {
  license: LicenseView;
  repository: string | null;
  /** `--publisher` only: the original publisher's `funding` links were dropped from the copy. */
  fundingRemoved: boolean;
}

const FUNDING_REMOVED = "Funding links were removed; add your own before you publish.";

/** A refusal with its exit code; its message is printed as is. */
class CloneRefusal extends Error {
  constructor(
    message: string,
    readonly exitCode: 1 | 2,
  ) {
    super(message);
  }
}

// ---- phase 1: arguments and `--into` --------------------------------------------------------

interface RawArgs {
  id: string;
  flags: Map<string, string>;
  json: boolean;
}

function parseArgs(args: readonly string[]): RawArgs | undefined {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--json") json = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return undefined;
      flags.set(a, v);
      i += 1;
    } else if (a.startsWith("--")) return undefined;
    else positional.push(a);
  }
  const [id] = positional;
  if (id === undefined || positional.length !== 1) return undefined;
  return { id, flags, json };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

/** `lstat` of `p`, or undefined when nothing is there (ENOENT, or ENOTDIR under a file). */
function lstatOrAbsent(p: string): Stats | undefined {
  try {
    return lstatSync(p);
  } catch (e) {
    const code = errnoCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw new CloneRefusal(`cannot use ${clean(p)}: ${clean(errorMessage(e))}`, 2);
  }
}

function existingIntoMessage(into: string, st: Stats): string {
  const dir = clean(into);
  if (st.isSymbolicLink()) return `${dir} is a symbolic link`;
  if (st.isDirectory() && readdirSync(into).length === 0) {
    return `${dir} already exists; clone needs a new directory`;
  }
  return `${dir} already exists and is not empty`;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `--into` must not exist at all, and its parent must be a directory. Refuses (exit 2) otherwise. */
function checkInto(into: string): void {
  const st = lstatOrAbsent(into);
  if (st !== undefined) throw new CloneRefusal(existingIntoMessage(into, st), 2);
  if (!isDirectory(dirname(into))) {
    throw new CloneRefusal(`the parent of ${clean(into)} does not exist`, 2);
  }
}

function checkSourceId(id: string): string {
  try {
    assertSafeExtensionId(id);
    assertCanonicalExtensionId(id);
  } catch (e) {
    throw new CloneRefusal(clean(errorMessage(e)), 2);
  }
  return id.slice(id.lastIndexOf("/") + 1);
}

function newIdFor(name: string, publisher: string): string {
  const problem = publisherIdProblem(publisher);
  if (problem !== undefined) throw new CloneRefusal(problem, 2);
  try {
    return resolveExtensionId(name, publisher);
  } catch (e) {
    throw new CloneRefusal(clean(errorMessage(e)), 2);
  }
}

function optionalString(key: string, v: string | undefined): Record<string, string> {
  return v === undefined ? {} : { [key]: v };
}

function buildPlan(raw: RawArgs, cwd: string): Plan {
  const name = checkSourceId(raw.id);
  const publisher = raw.flags.get("--publisher");
  const newId = publisher === undefined ? undefined : newIdFor(name, publisher);
  const into = resolve(cwd, raw.flags.get("--into") ?? name);
  checkInto(into);
  return {
    id: raw.id,
    ...optionalString("registry", raw.flags.get("--registry")),
    ...optionalString("version", raw.flags.get("--version")),
    into,
    ...optionalString("publisher", publisher),
    ...optionalString("newId", newId),
    json: raw.json,
  };
}

// ---- phase 2: the gateway's verified fetch ---------------------------------------------------

function isExpectedError(e: unknown): e is Error {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (
    m.includes("ERR_REGISTRY_") ||
    m.includes("ERR_EXTENSION_KEY_REVOKED") ||
    m.includes("ERR_EXTENSION_TAKEN_DOWN")
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function readVerifiedPublisher(v: unknown): CloneSource["verifiedPublisher"] {
  if (typeof v !== "object" || v === null) return null;
  const { github, verifiedAt } = v as { github?: unknown; verifiedAt?: unknown };
  if (typeof github !== "string" || typeof verifiedAt !== "string") return null;
  return { github, verifiedAt };
}

function readReply(raw: unknown): CloneSource {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    id: str(r["id"]),
    version: str(r["version"]),
    channel: str(r["channel"]),
    registry: str(r["registry"]),
    publisherId: str(r["publisherId"]),
    keyFingerprint: str(r["keyFingerprint"]),
    verifiedPublisher: readVerifiedPublisher(r["verifiedPublisher"]),
    packageSha256: str(r["packageSha256"]),
    archivePath: str(r["archivePath"]),
  };
}

async function fetchSource(client: IPCClient, plan: Plan): Promise<CloneSource> {
  try {
    const raw = await client.call<unknown>("registry.cloneSource", {
      id: plan.id,
      ...optionalString("registry", plan.registry),
      ...optionalString("version", plan.version),
    });
    return readReply(raw);
  } catch (e) {
    if (!isExpectedError(e)) throw e;
    throw new CloneRefusal(clean(e.message), 1);
  }
}

// ---- phase 3: the staged archive -------------------------------------------------------------

/** `<…>/registry-clone-staging/c-*\/package.tgz`, absolute and already normalised. */
function isStagingPath(p: string): boolean {
  if (p === "" || !isAbsolute(p) || resolve(p) !== p) return false;
  const stage = dirname(p);
  return (
    basename(p) === ARCHIVE_NAME &&
    basename(stage).startsWith(STAGE_PREFIX) &&
    basename(dirname(stage)) === STAGING_ROOT_NAME
  );
}

/** Removes only the archive and then its `c-*` directory (non-recursive); failures are ignored. */
function removeStaged(archivePath: string): void {
  try {
    unlinkSync(archivePath);
  } catch {
    /* already gone, or the gateway's sweep will remove it */
  }
  try {
    rmdirSync(dirname(archivePath));
  } catch {
    /* not empty or already gone: left for the gateway's sweep */
  }
}

/** Reads the staged archive ONCE and checks the bytes read; the staged entry is always removed. */
function takeStagedArchive(src: CloneSource): Buffer {
  if (!isStagingPath(src.archivePath)) {
    throw new CloneRefusal(
      "the gateway returned an unexpected staging path; nothing was written",
      1,
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(src.archivePath);
  } catch {
    throw new CloneRefusal("the staged package could not be read; nothing was written", 1);
  } finally {
    removeStaged(src.archivePath);
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== src.packageSha256) {
    throw new CloneRefusal("the staged package changed before it was read; nothing was written", 1);
  }
  return bytes;
}

// ---- phases 4-6: unpack, copy, rewrite, record -----------------------------------------------

/** Whether `p` is below `root` (never `root` itself); both absolute. Exported for its tests. */
export function isStrictlyInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function copyFiles(files: readonly string[], from: string, into: string): void {
  const fromRoot = resolve(from);
  const intoRoot = resolve(into);
  for (const rel of files) {
    const source = resolve(fromRoot, rel);
    const dest = resolve(intoRoot, rel);
    if (!isStrictlyInside(fromRoot, source) || !isStrictlyInside(intoRoot, dest)) {
      throw new CloneRefusal(`package file ${clean(rel)} is outside the package; refused`, 1);
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest, constants.COPYFILE_EXCL);
  }
}

function rewriteManifest(manifest: Record<string, unknown>, plan: Plan): string {
  const { signature: _signature, publisher: _publisher, ...rest } = manifest;
  if (plan.publisher === undefined || plan.newId === undefined) {
    return `${JSON.stringify(rest, null, 2)}\n`;
  }
  // The original publisher's funding links never travel into a copy someone else will publish.
  const { funding: _funding, ...own } = rest;
  const out = { ...own, id: plan.newId, publisher: { id: plan.publisher } };
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Whether the copy drops the manifest's `funding`: only a `--publisher` clone, which re-publishes. */
function dropsFunding(manifest: Record<string, unknown>, plan: Plan): boolean {
  return plan.publisher !== undefined && plan.newId !== undefined && "funding" in manifest;
}

function verifiedText(v: CloneSource["verifiedPublisher"]): string {
  return v === null ? "Unverified publisher" : `Verified publisher: @${clean(v.github)}`;
}

function notesText(src: CloneSource, repository: string | null, now: Date): string {
  const v = src.verifiedPublisher;
  const verified =
    v === null ? "Unverified publisher" : `${verifiedText(v)} (verified ${clean(v.verifiedAt)})`;
  const lines = [
    `# Cloned from ${clean(src.id)}`,
    "",
    "This directory is an editable copy of a published Nimbus extension. The original",
    "publisher's identity and signature were removed; sign it as yourself before you publish it.",
    "",
    `- Original id: ${clean(src.id)}`,
    `- Version: ${clean(src.version)}`,
    `- Channel: ${clean(src.channel)}`,
    `- Registry: ${clean(src.registry)}`,
    `- Publisher id: ${clean(src.publisherId)}`,
    `- Publisher key fingerprint: ${clean(src.keyFingerprint)}`,
    `- ${verified}`,
    `- Cloned at: ${now.toISOString()}`,
  ];
  if (repository !== null) lines.push(`- Repository: https://github.com/${clean(repository)}`);
  return `${lines.join("\n")}\n`;
}

/** Creates `--into` (non-recursive); one that appeared since the check is refused. */
function createInto(into: string): void {
  try {
    mkdirSync(into);
  } catch (e) {
    if (errnoCode(e) === "EEXIST") {
      throw new CloneRefusal(`${clean(into)} appeared while cloning; nothing was written`, 1);
    }
    throw new CloneRefusal(clean(errorMessage(e)), 1);
  }
}

/** The package must be the extension asked for; checked before `--into` is created. */
function checkManifestId(inspected: InspectedPackage, src: CloneSource): void {
  const mid = inspected.manifest["id"];
  if (mid !== src.id) {
    throw new CloneRefusal(
      `the package's manifest names ${clean(String(mid))}, not ${clean(src.id)}; nothing was written`,
      1,
    );
  }
}

/** Fills the `--into` clone just created; any failure removes it (clone created it). */
function populateInto(
  plan: Plan,
  src: CloneSource,
  inspected: InspectedPackage,
  extracted: string,
  now: Date,
): void {
  createInto(plan.into);
  try {
    copyFiles(inspected.files, extracted, plan.into);
    writeFileSync(join(plan.into, MANIFEST_FILE), rewriteManifest(inspected.manifest, plan));
    const repository = readManifestRepository(inspected.manifest) ?? null;
    writeFileSync(join(plan.into, NOTES_FILE), notesText(src, repository, now));
  } catch (e) {
    rmSync(plan.into, { recursive: true, force: true });
    if (e instanceof CloneRefusal) throw e;
    throw new CloneRefusal(
      `could not write the copy: ${clean(errorMessage(e))}; ${clean(plan.into)} was removed`,
      1,
    );
  }
}

async function writeCopy(
  plan: Plan,
  src: CloneSource,
  bytes: Buffer,
  deps: CloneDeps,
): Promise<InspectedPackage> {
  const work = mkdtempSync(join(deps.tmpDir, "nimbus-clone-"));
  try {
    const tgz = join(work, ARCHIVE_NAME);
    writeFileSync(tgz, bytes, { mode: 0o600 });
    let inspected: InspectedPackage;
    try {
      inspected = await inspectPackage(tgz, work);
    } catch (e) {
      // A registry rule (size, entry type, manifest) or tar's own refusal; nothing is in `--into` yet.
      const detail =
        e instanceof RegistryError ? e.message : `ERR_REGISTRY_EXTRACT_FAILED: ${errorMessage(e)}`;
      throw new CloneRefusal(clean(detail), 1);
    }
    checkManifestId(inspected, src);
    populateInto(plan, src, inspected, join(work, "x"), deps.now());
    return inspected;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- phase 7: the report ---------------------------------------------------------------------

function licenseView(manifest: Record<string, unknown>): LicenseView {
  const l = readManifestLicense(manifest);
  if (l.kind === "absent") {
    return { line: "License: not declared", value: null, warning: "no licence is declared" };
  }
  if (l.kind === "invalid") {
    return {
      line: "License: (invalid, ignored)",
      value: null,
      warning: "the declared licence is malformed",
    };
  }
  const ids = nonOsiLicenseIds(l.value);
  return {
    line: `License: ${clean(l.value)}`,
    value: l.value,
    warning: ids.length === 0 ? null : `${ids.join(", ")} is not an OSI-approved licence id`,
  };
}

function nextSteps(plan: Plan, src: CloneSource): string[] {
  const dir = clean(plan.into);
  if (plan.publisher !== undefined) {
    return [`Sign it first: nimbus extension keygen (once), then nimbus extension sign ${dir}`];
  }
  return [
    `Install it unsigned with: nimbus extension install ${dir}`,
    `(refused while ${clean(src.id)} is installed: remove it first or clone with --publisher)`,
  ];
}

function humanLines(plan: Plan, src: CloneSource, r: CloneResult): string[] {
  const lines = [
    `Cloned ${clean(src.id)}@${clean(src.version)} from ${clean(src.registry)} into ${clean(plan.into)}`,
    `Original publisher: ${clean(src.publisherId)} (key ${clean(src.keyFingerprint)}), ${verifiedText(src.verifiedPublisher)}`,
    r.license.line,
  ];
  if (r.license.warning !== null) {
    lines.push(`Warning: ${clean(r.license.warning)}; ${LICENCE_ADVICE}`);
  }
  lines.push(
    r.repository === null
      ? "This copy is built JavaScript (dist/); the package names no source repository."
      : `Source: https://github.com/${clean(r.repository)}`,
  );
  if (r.fundingRemoved) lines.push(FUNDING_REMOVED);
  return [...lines, ...nextSteps(plan, src)];
}

function jsonReport(plan: Plan, src: CloneSource, r: CloneResult): string {
  const v = src.verifiedPublisher;
  const cleanOrNull = (s: string | null): string | null => (s === null ? null : clean(s));
  return `${JSON.stringify(
    {
      id: clean(src.id),
      version: clean(src.version),
      registry: clean(src.registry),
      into: plan.into,
      publisherId: clean(src.publisherId),
      keyFingerprint: clean(src.keyFingerprint),
      verifiedPublisher:
        v === null ? null : { github: clean(v.github), verifiedAt: clean(v.verifiedAt) },
      license: cleanOrNull(r.license.value),
      licenseWarning: cleanOrNull(r.license.warning),
      repository: cleanOrNull(r.repository),
      newId: plan.newId ?? null,
      fundingRemoved: r.fundingRemoved,
    },
    null,
    2,
  )}\n`;
}

// ---- the command -----------------------------------------------------------------------------

async function clone(args: readonly string[], deps: CloneDeps): Promise<number> {
  const raw = parseArgs(args);
  if (raw === undefined) {
    deps.err(USAGE);
    return 2;
  }
  const plan = buildPlan(raw, deps.cwd);
  const src = await fetchSource(deps.client, plan);
  const bytes = takeStagedArchive(src);
  const inspected = await writeCopy(plan, src, bytes, deps);
  const result: CloneResult = {
    license: licenseView(inspected.manifest),
    repository: readManifestRepository(inspected.manifest) ?? null,
    fundingRemoved: dropsFunding(inspected.manifest, plan),
  };
  if (plan.json) deps.log(jsonReport(plan, src, result));
  else deps.log(`${humanLines(plan, src, result).join("\n")}\n`);
  return 0;
}

/** Exit 0 on success; 1 for a refused or failed clone; 2 for usage or an unusable `--into`. */
export async function runExtensionClone(args: readonly string[], deps: CloneDeps): Promise<number> {
  try {
    return await clone(args, deps);
  } catch (e) {
    if (!(e instanceof CloneRefusal)) throw e;
    deps.err(`${e.message}\n`);
    return e.exitCode;
  }
}

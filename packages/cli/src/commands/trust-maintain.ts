/**
 * `nimbus trust maintain …` — offline tooling for the Nimbus trust feed (marketplace trust layer,
 * spec § 6.13). Pure CLI: no gateway, no network, no Vault. The feed's SOURCE is a folder of
 * `publishers/`, `requests/` and `statements/` files (`trust-feed-build.ts` in registry-format); every
 * source command only writes those files, so it works the same on a local folder and on a clone of
 * the GitHub feed repository. `sign` builds the next signed `trust.json` of a LOCAL folder; a
 * `--github` feed is signed by its `trust-sign` workflow, which runs the same builder.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildTrustFeed,
  emptyTrustFeed,
  FEED_CONFIG_FILE,
  FEED_PUBLISHERS_DIR,
  FEED_REQUESTS_DIR,
  FEED_STATEMENTS_DIR,
  type FeedPlan,
  type FeedSkip,
  type FeedSource,
  type FeedSourceFile,
  PUBLISHER_ID_RE,
  PUBLISHER_KEY_RE,
  parsePublisherFile,
  parseTrustFeed,
  parseTrustStatement,
  planTrustFeed,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  RegistryError,
  signTrustFeed,
  TRUST_FEED_FILE,
  type TrustFeed,
  trustStatementId,
  verifyTrustFeedPinned,
  verifyTrustStatement,
} from "@nimbus-dev/registry-format";
import { encodeBase64, generateEd25519Keypair } from "../lib/extension-signing.ts";
import {
  DEFAULT_BUILD,
  DEFAULT_IO,
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
  writeRequestJson,
  writeRootKey,
} from "../lib/maintain-shared.ts";
import { trustOwnerNextSteps, trustReadme } from "./trust-templates/readme.ts";
import { trustCheckWorkflow, trustSignWorkflow } from "./trust-templates/workflows.ts";

export const TRUST_MAINTAIN_USAGE =
  "Usage: nimbus trust maintain init <dir> [--key <path>] [--force] [--github [--action-ref <40-hex>] [--site <path>] [--default-branch <name>]]\n" +
  "       nimbus trust maintain verify-publisher <dir> <publisherId> --key <public key file|base64>... --github <handle>\n" +
  "       nimbus trust maintain unverify-publisher <dir> <publisherId>\n" +
  "       nimbus trust maintain revoke-key <dir> <fingerprint> --publisher <id> --reason <text>\n" +
  "       nimbus trust maintain takedown <dir> <id>[@<version>] --publisher <id> --reason <text>\n" +
  "       nimbus trust maintain add-statement <dir> <statement file>\n" +
  "       nimbus trust maintain plan <dir>\n" +
  "       nimbus trust maintain sign <dir> [--key <path>]\n";

/** What `sign` reads the clock with; injectable for tests. */
export interface TrustMaintainEnv {
  readonly io: MaintainIo;
  readonly build: MaintainBuild;
  readonly now: () => Date;
}

const DEFAULT_ENV: TrustMaintainEnv = {
  io: DEFAULT_IO,
  build: DEFAULT_BUILD,
  now: () => new Date(),
};

const GITHUB_ONLY = ["--action-ref", "--site", "--default-branch"] as const;

function keyPathOf(p: ParsedArgs): string {
  return p.options.get("--key") ?? join(homedir(), ".nimbus", "trust-root-key");
}

function requireDir(dir: string | undefined, what: string): string {
  if (dir === undefined) throw new MaintainError(`${what} needs <dir>`);
  if (!existsSync(join(dir, FEED_CONFIG_FILE))) {
    throw new MaintainError(
      `${join(dir, FEED_CONFIG_FILE)} not found; run \`nimbus trust maintain init\` first`,
    );
  }
  return dir;
}

function writeAtomic(dir: string, name: string, text: string): void {
  const tmp = join(dir, `${name}.${String(process.pid)}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, join(dir, name));
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/* ------------------------------------------------------------------------------------------------ */
/* init                                                                                              */
/* ------------------------------------------------------------------------------------------------ */

const SOURCE_FILES: ReadonlyArray<readonly [string, string]> = [
  [FEED_CONFIG_FILE, json({ format: 1 })],
  [`${FEED_PUBLISHERS_DIR}.gitkeep`, ""],
  [`${FEED_REQUESTS_DIR}.gitkeep`, ""],
  [`${FEED_STATEMENTS_DIR}.gitkeep`, ""],
];

function writeFiles(root: string, files: ReadonlyArray<readonly [string, string]>): void {
  for (const [rel, text] of files) {
    const path = join(root, ...rel.split("/"));
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}

interface InitPlan {
  github: boolean;
  site: string | undefined;
  files: ReadonlyArray<readonly [string, string]>;
  defaultBranch: string;
}

function planInit(p: ParsedArgs, dir: string, keyPath: string, build: MaintainBuild): InitPlan {
  const github = p.flags.has("--github");
  if (!github) {
    const stray = GITHUB_ONLY.find((o) => p.options.has(o));
    if (stray !== undefined) throw new MaintainError(`${stray} needs --github`);
    if (isSameOrInside(keyPath, dir)) {
      throw new MaintainError(
        `the trust root key ${keyPath} would be inside ${dir}; keep it outside the feed folder (the default is ~/.nimbus/trust-root-key)`,
      );
    }
    return { github, site: undefined, files: SOURCE_FILES, defaultBranch: "main" };
  }
  const pin = resolveActionPin(p, build);
  const defaultBranch = resolveDefaultBranch(p);
  const site = p.options.get("--site") ?? `${resolve(dir)}-site`;
  if (isSameOrInside(site, dir) || isSameOrInside(dir, site)) {
    throw new MaintainError(`--site ${site} overlaps ${dir}; neither folder may hold the other`);
  }
  for (const folder of [dir, site]) {
    if (isSameOrInside(keyPath, folder)) {
      throw new MaintainError(
        `the trust root key ${keyPath} would be inside ${folder}, which is pushed to GitHub; keep it outside both folders (the default is ~/.nimbus/trust-root-key)`,
      );
    }
  }
  const files: Array<readonly [string, string]> = [
    ...SOURCE_FILES,
    [".github/workflows/trust-check.yml", trustCheckWorkflow(pin, defaultBranch)],
    [".github/workflows/trust-sign.yml", trustSignWorkflow(pin, defaultBranch)],
    ["README.md", trustReadme(defaultBranch)],
  ];
  return { github, site, files, defaultBranch };
}

async function maintainInit(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(
    args,
    ["--key", "--action-ref", "--site", "--default-branch"],
    ["--force", "--github"],
  );
  const dir = p.positional[0];
  if (dir === undefined || p.positional.length !== 1) throw new MaintainError("init needs <dir>");
  const force = p.flags.has("--force");
  const keyPath = keyPathOf(p);
  const plan = planInit(p, dir, keyPath, env.build);
  const feedDir = plan.site ?? dir;
  if (!force) {
    const targets = [
      ...plan.files.map(([rel]) => join(dir, ...rel.split("/"))),
      join(feedDir, TRUST_FEED_FILE),
    ];
    const taken = targets.find((t) => existsSync(t));
    if (taken !== undefined) {
      throw new MaintainError(`${taken} exists; refusing to overwrite without --force`);
    }
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  writeRootKey(keyPath, privkey, force);
  const rootKey = encodeBase64(pubkey);
  const feed = await signTrustFeed(emptyTrustFeed(rootKey, env.now().toISOString()), privkey);
  writeFiles(dir, plan.files);
  mkdirSync(feedDir, { recursive: true });
  writeAtomic(feedDir, TRUST_FEED_FILE, json(feed));
  if (plan.site !== undefined) writeFiles(plan.site, SITE_FILES);
  const io = env.io;
  if (plan.site === undefined) {
    io.stdout(`trust feed initialised in ${dir} (sequence 1)\n`);
  } else {
    io.stdout(`trust feed repository written to ${dir} (push it to ${plan.defaultBranch})\n`);
    io.stdout(`initial site written to ${plan.site} (sequence 1; push it as gh-pages)\n`);
  }
  io.stdout(`root key:    ${rootKey}\n`);
  io.stdout(`fingerprint: ${publisherKeyFingerprint(rootKey)}\n`);
  io.stdout(`key file:    ${keyPath} (keep it secret, offline and backed up)\n`);
  if (plan.site !== undefined) {
    io.stdout("\n");
    io.stdout(
      trustOwnerNextSteps({ dir, site: plan.site, keyPath, defaultBranch: plan.defaultBranch }),
    );
  }
}

/* ------------------------------------------------------------------------------------------------ */
/* Source commands                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

const SOURCE_NOTE =
  "On a clone of the GitHub feed repository: commit it on a branch, open a pull request and merge; the trust-sign workflow signs it. On a local feed folder: run `nimbus trust maintain sign`.\n";

/** A public key given as a file holding its base64, or as the base64 itself. */
function readPublicKey(raw: string): string {
  const value = PUBLISHER_KEY_RE.test(raw) ? raw : readKeyFile(raw);
  if (!PUBLISHER_KEY_RE.test(value)) {
    throw new MaintainError(`--key ${raw} is not a base64 Ed25519 public key`);
  }
  return value;
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    throw new MaintainError(`--key ${path} is neither a public key nor a readable file`);
  }
}

async function maintainVerify(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(args, ["--github"], [], ["--key"]);
  const [rawDir, publisherId] = p.positional;
  const dir = requireDir(rawDir, "verify-publisher");
  const github = p.options.get("--github");
  const keys = (p.lists.get("--key") ?? []).map(readPublicKey);
  if (
    publisherId === undefined ||
    p.positional.length !== 2 ||
    github === undefined ||
    keys.length === 0
  ) {
    throw new MaintainError(
      "verify-publisher needs <dir> <publisherId> --key <public key>... --github <handle>",
    );
  }
  const rel = `${FEED_PUBLISHERS_DIR}${publisherId}.json`;
  // The format's own rules (id, 1–10 distinct keys, handle), before anything is written.
  const entry = parsePublisherFile(rel, { publisherId, keys, github });
  mkdirSync(join(dir, FEED_PUBLISHERS_DIR), { recursive: true });
  writeAtomic(join(dir, FEED_PUBLISHERS_DIR), `${publisherId}.json`, json(entry));
  env.io.stdout(
    `wrote ${join(dir, rel)}: ${publisherId} verified as @${entry.github} with ${entry.keys.map(publisherKeyFingerprint).join(", ")}\n${SOURCE_NOTE}`,
  );
}

async function maintainUnverify(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(args, [], []);
  const [rawDir, publisherId] = p.positional;
  const dir = requireDir(rawDir, "unverify-publisher");
  if (publisherId === undefined || p.positional.length !== 2) {
    throw new MaintainError("unverify-publisher needs <dir> <publisherId>");
  }
  // Validated before it becomes a path: `../x` must never reach rmSync.
  if (!PUBLISHER_ID_RE.test(publisherId)) {
    throw new MaintainError(`${publisherId} is not a publisher id`);
  }
  const path = join(dir, FEED_PUBLISHERS_DIR, `${publisherId}.json`);
  if (!existsSync(path)) throw new MaintainError(`${publisherId} is not verified in ${dir}`);
  rmSync(path);
  env.io.stdout(
    `removed ${path}: the next feed drops ${publisherId}'s badge (blocks are never removed)\n${SOURCE_NOTE}`,
  );
}

async function maintainBlock(
  kind: "key.revoke" | "extension.takedown",
  args: string[],
  env: TrustMaintainEnv,
): Promise<void> {
  const p = parseArgs(args, ["--publisher", "--reason"], []);
  const [rawDir, subject] = p.positional;
  const name = kind === "key.revoke" ? "revoke-key" : "takedown";
  const dir = requireDir(rawDir, name);
  if (subject === undefined || p.positional.length !== 2) {
    const what = kind === "key.revoke" ? "<fingerprint>" : "<id>[@<version>]";
    throw new MaintainError(`${name} needs <dir> ${what}`);
  }
  // A feed binds no extensions, so a takedown must name its publisher (the builder would skip it).
  const req = requestFrom(kind, p, subject, true);
  const { path, status } = writeRequestJson(dir, FEED_REQUESTS_DIR, req);
  env.io.stdout(
    status === "same"
      ? `${path} already requested; nothing written\n`
      : `wrote ${path}\n${SOURCE_NOTE}`,
  );
}

async function maintainAddStatement(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(args, [], []);
  const [rawDir, file] = p.positional;
  const dir = requireDir(rawDir, "add-statement");
  if (file === undefined || p.positional.length !== 2) {
    throw new MaintainError("add-statement needs <dir> <statement file>");
  }
  let s: ReturnType<typeof parseTrustStatement>;
  try {
    s = parseTrustStatement(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch (e) {
    throw new MaintainError(
      `${file} is not a statement: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (verifyTrustStatement(s, {}) !== "publisher") {
    throw new MaintainError(
      `${file} is not signed by the key it concerns; add-statement carries a publisher's own key.rotate or key.revoke`,
    );
  }
  const id = trustStatementId(s);
  mkdirSync(join(dir, FEED_STATEMENTS_DIR), { recursive: true });
  writeAtomic(join(dir, FEED_STATEMENTS_DIR), `${id}.json`, json(s));
  env.io.stdout(`wrote ${join(dir, FEED_STATEMENTS_DIR, `${id}.json`)}\n${SOURCE_NOTE}`);
}

/* ------------------------------------------------------------------------------------------------ */
/* plan / sign                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

/** Every `<dir>/<sub>/*.json`, parsed; a file that is not JSON is a skip, not a throw. */
function readSourceDir(dir: string, sub: string, skipped: FeedSkip[]): FeedSourceFile[] {
  const root = join(dir, sub);
  if (!existsSync(root)) return [];
  const out: FeedSourceFile[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = `${sub}${name}`;
    try {
      out.push({ path, raw: JSON.parse(readFileSync(join(root, name), "utf8")) as unknown });
    } catch {
      skipped.push({ path, reason: "not valid JSON" });
    }
  }
  return out;
}

export function readFeedSource(dir: string): { source: FeedSource; skipped: FeedSkip[] } {
  const skipped: FeedSkip[] = [];
  const source: FeedSource = {
    publishers: readSourceDir(dir, FEED_PUBLISHERS_DIR, skipped),
    requests: readSourceDir(dir, FEED_REQUESTS_DIR, skipped),
    statements: readSourceDir(dir, FEED_STATEMENTS_DIR, skipped),
  };
  return { source, skipped };
}

/** The local folder's signed `trust.json`, verified against its own root. */
async function readLocalFeed(dir: string): Promise<TrustFeed> {
  const path = join(dir, TRUST_FEED_FILE);
  if (!existsSync(path)) {
    throw new MaintainError(
      `${path} not found: a --github feed keeps its signed trust.json on gh-pages and is signed by its trust-sign workflow`,
    );
  }
  const feed = parseTrustFeed(new Uint8Array(readFileSync(path)));
  await verifyTrustFeedPinned(feed, feed.rootKey);
  return feed;
}

/** The plan as text: what the next feed changes, and every skipped file with its reason. */
export function formatFeedPlan(plan: FeedPlan, skipped: readonly FeedSkip[]): string {
  const lines: string[] = [];
  for (const b of plan.blocks) {
    const r = b.request;
    lines.push(
      r.kind === "key.revoke"
        ? `  revoke key ${r.keyFingerprint} of ${r.publisherId} (${b.path})`
        : `  take down ${r.extensionId}${r.versions === "*" ? "" : `@${r.versions.join(",")}`} of ${r.publisherId ?? "?"} (${b.path})`,
    );
  }
  for (const v of plan.verified) {
    lines.push(
      `  verify ${v.publisherId} as @${v.github} (${v.change}): ${v.keys.map(publisherKeyFingerprint).join(", ")}`,
    );
  }
  for (const id of plan.unverified) lines.push(`  un-verify ${id}`);
  for (const s of plan.admitted)
    lines.push(`  carry ${s.kind} of ${s.publisherId} (${trustStatementId(s)})`);
  const head =
    plan.status === "unchanged" ? "Nothing to sign.\n" : `The next feed:\n${lines.join("\n")}\n`;
  const skips = [...skipped, ...plan.skipped];
  if (skips.length === 0) return head;
  return `${head}Skipped (not signed):\n${skips.map((s) => `  ${s.path}: ${s.reason}`).join("\n")}\n`;
}

async function maintainPlan(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(args, [], []);
  const dir = requireDir(p.positional[0], "plan");
  const { source, skipped } = readFeedSource(dir);
  const feed = await readLocalFeed(dir);
  env.io.stdout(formatFeedPlan(planTrustFeed(feed, source), skipped));
}

async function maintainSign(args: string[], env: TrustMaintainEnv): Promise<void> {
  const p = parseArgs(args, ["--key"], []);
  const dir = requireDir(p.positional[0], "sign");
  if (p.positional.length !== 1) throw new MaintainError("sign needs <dir>");
  const prev = await readLocalFeed(dir);
  const seed = loadSeed(keyPathOf(p));
  try {
    if (encodeBase64(publicKeyFromSeed(seed)) !== prev.rootKey) {
      throw new MaintainError("this trust feed is signed by a different key than --key");
    }
    const { source, skipped } = readFeedSource(dir);
    const { plan, feed } = await buildTrustFeed(prev, source, seed, env.now().toISOString());
    env.io.stdout(formatFeedPlan(plan, skipped));
    if (feed === undefined) return;
    writeAtomic(dir, TRUST_FEED_FILE, json(feed));
    env.io.stdout(`signed ${join(dir, TRUST_FEED_FILE)}; sequence ${String(feed.sequence)}\n`);
  } finally {
    seed.fill(0);
  }
}

export async function runTrustMaintain(
  args: string[],
  env: TrustMaintainEnv = DEFAULT_ENV,
): Promise<number> {
  const [sub, ...rest] = args;
  const handlers: Record<string, (a: string[], env: TrustMaintainEnv) => Promise<void>> = {
    init: maintainInit,
    "verify-publisher": maintainVerify,
    "unverify-publisher": maintainUnverify,
    "revoke-key": (a, e) => maintainBlock("key.revoke", a, e),
    takedown: (a, e) => maintainBlock("extension.takedown", a, e),
    "add-statement": maintainAddStatement,
    plan: maintainPlan,
    sign: maintainSign,
  };
  const handler = sub === undefined ? undefined : handlers[sub];
  if (handler === undefined) {
    env.io.stderr(TRUST_MAINTAIN_USAGE);
    return 2;
  }
  try {
    await handler(rest, env);
    return 0;
  } catch (e) {
    if (e instanceof MaintainError || e instanceof RegistryError) {
      env.io.stderr(`${e.message}\n`);
      return 2;
    }
    env.io.stderr(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

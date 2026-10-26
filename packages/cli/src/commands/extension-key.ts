/**
 * `nimbus extension key rotate|revoke` (marketplace trust layer, spec § 6.10): publisher tooling that
 * writes a signed trust statement to a file. No gateway, no network.
 *
 * - `rotate --from <old key file> --to <new key file> --publisher <id>` writes a `key.rotate`
 *   signed by the OLD key: "my next key is the new one". Updates signed by the new key then apply
 *   on users' machines without a prompt once the statement reaches them (in a registry index via
 *   `nimbus extension publish --statement`, or in the trust feed).
 * - `revoke --key <key file> --publisher <id> --reason <text>` writes a `key.revoke` signed by the
 *   key it revokes. It is permanent.
 *
 * Key files are the `nimbus extension keygen` format: base64 of a 32-byte Ed25519 seed on one line.
 * A seed is read, used and never printed; messages name key FILES and public fingerprints only.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  parseTrustStatement,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  RegistryError,
  signTrustStatement,
  type TrustStatement,
  trustStatementId,
  type UnsignedTrustStatement,
} from "@nimbus-dev/registry-format";

export interface KeyCmdDeps {
  /** Where a statement file goes when `--out` is not given. */
  cwd: string;
  now: () => Date;
  log: (s: string) => void;
  err: (s: string) => void;
}

const DEFAULT_DEPS: KeyCmdDeps = {
  cwd: process.cwd(),
  now: () => new Date(),
  log: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

const USAGE =
  "Usage: nimbus extension key rotate --from <old key file> --to <new key file> --publisher <id> [--out <file>] [--force]\n" +
  "       nimbus extension key revoke --key <key file> --publisher <id> --reason <text> [--out <file>] [--force]\n";

const VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  rotate: ["--from", "--to", "--publisher", "--out"],
  revoke: ["--key", "--publisher", "--reason", "--out"],
};

/** A refusal; exit 2. */
class KeyCmdError extends Error {}

interface ParsedArgs {
  sub: "rotate" | "revoke";
  options: Map<string, string>;
  force: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const [sub, ...rest] = args;
  if (sub !== "rotate" && sub !== "revoke") {
    throw new KeyCmdError(`unknown subcommand ${sub === undefined ? "(none)" : sub}`);
  }
  const allowed = VALUE_OPTIONS[sub] ?? [];
  const options = new Map<string, string>();
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--force") {
      force = true;
      continue;
    }
    if (!allowed.includes(a)) throw new KeyCmdError(`unknown option ${a}`);
    const v = rest[i + 1];
    if (v === undefined) throw new KeyCmdError(`${a} needs a value`);
    options.set(a, v);
    i++;
  }
  return { sub, options, force };
}

function required(p: ParsedArgs, name: string): string {
  const v = p.options.get(name);
  if (v === undefined || v === "") throw new KeyCmdError(`${name} is required`);
  return v;
}

/** The seed in a key file. The message names the path, never the content. */
function readSeed(path: string): Uint8Array {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new KeyCmdError(
      `could not read key file ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`,
    );
  }
  const seed = new Uint8Array(Buffer.from(text.trim(), "base64"));
  if (seed.length !== 32)
    throw new KeyCmdError(`key file ${path} did not decode to a 32-byte seed`);
  return seed;
}

const publicKeyOf = (seed: Uint8Array): string =>
  Buffer.from(publicKeyFromSeed(seed)).toString("base64");

async function buildStatement(p: ParsedArgs, issuedAt: string): Promise<TrustStatement> {
  const publisherId = required(p, "--publisher");
  if (p.sub === "rotate") {
    const fromSeed = readSeed(required(p, "--from"));
    const toKey = publicKeyOf(readSeed(required(p, "--to")));
    const fromKey = publicKeyOf(fromSeed);
    if (fromKey === toKey) throw new KeyCmdError("--from and --to are the same key");
    return sign(
      { kind: "key.rotate", issuedAt, signerKey: fromKey, publisherId, fromKey, toKey },
      fromSeed,
    );
  }
  const reason = required(p, "--reason");
  const seed = readSeed(required(p, "--key"));
  const key = publicKeyOf(seed);
  return sign(
    {
      kind: "key.revoke",
      issuedAt,
      signerKey: key,
      publisherId,
      keyFingerprint: publisherKeyFingerprint(key),
      reason,
    },
    seed,
  );
}

/** Sign, then re-parse: the format's own rules (publisher id, reason length) refuse a bad statement. */
async function sign(s: UnsignedTrustStatement, seed: Uint8Array): Promise<TrustStatement> {
  const signed = await signTrustStatement(s, seed);
  try {
    return parseTrustStatement(signed);
  } catch (e) {
    if (e instanceof RegistryError) throw new KeyCmdError(e.detail);
    throw e;
  }
}

function describeStatement(s: TrustStatement): string {
  if (s.kind === "key.rotate") {
    return `key.rotate for publisher ${s.publisherId}: ${publisherKeyFingerprint(s.fromKey)} -> ${publisherKeyFingerprint(s.toKey)}`;
  }
  if (s.kind === "key.revoke") {
    return `key.revoke for publisher ${s.publisherId}: key ${s.keyFingerprint} (permanent)`;
  }
  return s.kind;
}

function writeStatement(path: string, s: TrustStatement, force: boolean): void {
  try {
    writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`, { flag: force ? "w" : "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new KeyCmdError(`refusing to overwrite ${path} without --force`);
    }
    throw e;
  }
}

/** Exit 0 on success; 2 for a usage error or a refusal; 1 for anything unexpected. */
export async function runExtensionKey(
  args: readonly string[],
  deps: KeyCmdDeps = DEFAULT_DEPS,
): Promise<number> {
  try {
    const p = parseArgs(args);
    const s = await buildStatement(p, deps.now().toISOString());
    const id = trustStatementId(s);
    const out = p.options.get("--out") ?? `${id}.json`;
    const path = isAbsolute(out) ? out : join(deps.cwd, out);
    writeStatement(path, s, p.force);
    deps.log(
      `wrote ${path}\n` +
        `statement id ${id}\n` +
        `${describeStatement(s)}\n` +
        "Include it in your next publish: nimbus extension publish <dir> --registry-repo <owner/repo> " +
        `--statement ${path}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof KeyCmdError) {
      deps.err(`${e.message}\n${USAGE}`);
      return 2;
    }
    deps.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

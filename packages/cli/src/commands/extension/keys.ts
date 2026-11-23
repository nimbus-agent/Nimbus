import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertAuthorMetadata,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  RegistryError,
} from "@nimbus-dev/registry-format";
import {
  decodeBase64,
  encodeBase64,
  generateEd25519Keypair,
  signManifest,
} from "../../lib/extension-signing.ts";

export function runExtensionKeygen(args: string[]): Promise<number> {
  return Promise.try(() => writePublisherKeypair(args));
}

function writePublisherKeypair(args: string[]): number {
  const outIdx = args.indexOf("--out");
  const force = args.includes("--force");
  let outPath = join(homedir(), ".nimbus", "publisher-key");
  if (outIdx >= 0 && outIdx + 1 < args.length) {
    const candidate = args[outIdx + 1];
    if (candidate !== undefined) outPath = candidate;
  }
  const { privkey, pubkey } = generateEd25519Keypair();
  mkdirSync(dirname(outPath), { recursive: true });
  try {
    writeFileSync(outPath, `${encodeBase64(privkey)}\n`, {
      flag: force ? "w" : "wx",
      mode: 0o600,
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      process.stderr.write(`refusing to overwrite ${outPath} without --force\n`);
      return 2;
    }
    throw e;
  }
  if (process.platform !== "win32") chmodSync(outPath, 0o600);
  process.stdout.write(`${encodeBase64(pubkey)}\n`);
  return 0;
}

/**
 * Reconcile the manifest's `publisher` with the signing key before signing. A manifest that names a
 * publisher id but no key gets the signing key's public half (what scaffold leaves for you to fill
 * in); a manifest whose key differs from the signing key is refused rather than silently re-keyed.
 * Returns the refusal message, or undefined when signing may proceed. No `publisher` changes nothing.
 */
function applySigningPublisherKey(
  manifest: Record<string, unknown>,
  priv: Uint8Array,
): string | undefined {
  const publisher = manifest["publisher"];
  if (publisher === null || typeof publisher !== "object" || Array.isArray(publisher)) {
    return undefined;
  }
  const entry = publisher as Record<string, unknown>;
  const signingKey = encodeBase64(publicKeyFromSeed(priv));
  if (entry["key"] === undefined) {
    manifest["publisher"] = { ...entry, key: signingKey };
    return undefined;
  }
  if (entry["key"] === signingKey) return undefined;
  const manifestKey = typeof entry["key"] === "string" ? entry["key"] : "";
  return (
    "manifest publisher.key does not match the signing key; refusing to re-key it. " +
    `manifest key fingerprint: ${manifestKey === "" ? "(not a string)" : publisherKeyFingerprint(manifestKey)}, ` +
    `signing key fingerprint: ${publisherKeyFingerprint(signingKey)}`
  );
}

/** The signing key `--key` names (default `~/.nimbus/publisher-key`), or the refusal to print. */
function loadSigningKey(args: string[]): { priv: Uint8Array } | { refusal: string } {
  const keyIdx = args.indexOf("--key");
  let keyPath = join(homedir(), ".nimbus", "publisher-key");
  if (keyIdx >= 0 && keyIdx + 1 < args.length) {
    const candidate = args[keyIdx + 1];
    if (candidate !== undefined) keyPath = candidate;
  }
  let priv: Uint8Array;
  try {
    priv = decodeBase64(readFileSync(keyPath, "utf8").trim());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { refusal: `could not read key file ${keyPath}: ${msg}\n` };
  }
  if (priv.length !== 32) return { refusal: `key file ${keyPath} did not decode to 32 bytes\n` };
  return { priv };
}

export async function runExtensionSign(args: string[]): Promise<number> {
  const extDir = args[0];
  if (extDir === undefined || extDir.startsWith("--")) {
    process.stderr.write("usage: nimbus extension sign <ext-dir> [--key <path>]\n");
    return 2;
  }
  const key = loadSigningKey(args);
  if ("refusal" in key) {
    process.stderr.write(key.refusal);
    return 2;
  }
  const { priv } = key;
  const manifestPath = join(extDir, "nimbus.extension.json");
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`could not read manifest ${manifestPath}: ${msg}\n`);
    return 2;
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  try {
    assertAuthorMetadata(parsed);
  } catch (e) {
    if (!(e instanceof RegistryError)) throw e;
    const cut = e.detail.indexOf(": ");
    const field = cut < 0 ? e.detail : e.detail.slice(0, cut);
    const reason = cut < 0 ? "" : e.detail.slice(cut + 2);
    process.stderr.write(`manifest ${field} is invalid: ${reason}; fix it before signing\n`);
    return 2;
  }
  delete parsed["signature"];
  const keyRefusal = applySigningPublisherKey(parsed, priv);
  if (keyRefusal !== undefined) {
    process.stderr.write(`${keyRefusal}\n`);
    return 2;
  }
  const sig = await signManifest(parsed, priv);
  writeFileSync(manifestPath, JSON.stringify({ ...parsed, signature: sig }, null, 2));
  return 0;
}

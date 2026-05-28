import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

const PUBLIC_KEY_FILE = join(import.meta.dir, "..", "packages/gateway/src/updater/public-key.ts");

function isAlreadyConfigured(): boolean {
  if (!existsSync(PUBLIC_KEY_FILE)) {
    return false;
  }
  const body = readFileSync(PUBLIC_KEY_FILE, "utf8");
  const match = body.match(/UPDATER_PUBLIC_KEY_BASE64\s*=\s*"([^"]*)"/);
  if (!match) {
    return false;
  }
  const value = match[1] ?? "";
  return value.length > 0 && value !== "<DEV-PLACEHOLDER>";
}

if (isAlreadyConfigured()) {
  console.error(
    "refusing: public-key.ts already contains a non-dev key. Manual reset required for rotation.",
  );
  process.exit(2);
}

const seed = randomBytes(32);
const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(seed));
const pubB64 = Buffer.from(kp.publicKey).toString("base64");
const pubHex = Buffer.from(kp.publicKey).toString("hex");
const privB64 = Buffer.from(kp.secretKey).toString("base64");

console.log("Updater Ed25519 keypair generated.\n");
console.log("PUBLIC KEY (commit to packages/gateway/src/updater/public-key.ts):");
console.log(`  base64: ${pubB64}`);
console.log(`  hex:    ${pubHex}\n`);

const privDir = mkdtempSync(join(tmpdir(), "nimbus-updater-key-"));
const privPath = join(privDir, "updater-private.b64");
writeFileSync(privPath, privB64);
try {
  chmodSync(privPath, 0o600);
} catch {
  // Windows filesystems may not honour chmod
}

console.log("PRIVATE KEY written to:");
console.log(`  ${privPath}\n`);
console.log("Upload to GitHub secret UPDATER_SIGNING_KEY, then delete:");
console.log(`  gh secret set UPDATER_SIGNING_KEY < "${privPath}" && rm -f "${privPath}"`);

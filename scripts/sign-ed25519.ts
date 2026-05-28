import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import nacl from "tweetnacl";

const keyB64 = process.env["UPDATER_SIGNING_KEY"];
if (!keyB64) {
  console.error("signing skipped: UPDATER_SIGNING_KEY not set");
  process.exit(0);
}
const secretKey = new Uint8Array(Buffer.from(keyB64, "base64"));
if (secretKey.length !== 64) {
  console.error(`UPDATER_SIGNING_KEY must decode to 64 bytes, got ${secretKey.length}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: bun scripts/sign-ed25519.ts <binary> [<binary>...]");
  process.exit(1);
}

for (const path of args) {
  const bytes = new Uint8Array(readFileSync(path));
  const digest = new Uint8Array(createHash("sha256").update(bytes).digest());
  const sig = nacl.sign.detached(digest, secretKey);
  const sigB64 = Buffer.from(sig).toString("base64");
  const shaHex = Buffer.from(digest).toString("hex");
  writeFileSync(`${path}.sig`, sigB64);
  writeFileSync(`${path}.sha256`, shaHex);
  console.log(`signed: ${path}`);
}

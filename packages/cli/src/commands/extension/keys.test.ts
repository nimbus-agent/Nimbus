import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isolatePlatformEnv } from "../../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../../test/helpers/stream-capture.ts";
import { encodeBase64, generateEd25519Keypair } from "../../lib/extension-signing.ts";
import { runExtensionKeygen, runExtensionSign } from "./keys.ts";

/**
 * Edges of `keygen` and `sign` that `extension-keygen-sign.test.ts` leaves open: a flag given
 * with no value (the default path under the home directory, which is pointed at a temp folder
 * here), the file mode step on each platform, a key file that is the wrong length, and the three
 * ways a manifest's `publisher` can relate to the signing key. The platform is swapped for the
 * duration of one call and restored.
 */

const cap = createStreamCapture();
const stderr = (): string => cap.stderrChunks.join("");

let root: string;
let restoreEnv: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-ext-keys-"));
  restoreEnv = isolatePlatformEnv(root);
  cap.stdoutChunks.length = 0;
  cap.stderrChunks.length = 0;
  cap.install();
});
afterEach(() => {
  cap.restore();
  restoreEnv();
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function withPlatform<T>(platform: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (original !== undefined) Object.defineProperty(process, "platform", original);
  }
}

describe("runExtensionKeygen", () => {
  test.each(["win32", "linux"])("writes the key and answers 0 as if on %s", async (platform) => {
    const out = join(root, "key");
    expect(await withPlatform(platform, () => runExtensionKeygen(["--out", out]))).toBe(0);
    expect(readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
  });

  test("--out with no value falls back to the default file under the home directory", async () => {
    // On macOS `os.homedir()` ignores an in-process HOME, so the default would be a real profile.
    if (!homedir().startsWith(root)) return;
    expect(await runExtensionKeygen(["--out"])).toBe(0);
    expect(existsSync(join(homedir(), ".nimbus", "publisher-key"))).toBe(true);
  });
});

describe("runExtensionSign", () => {
  async function keyFile(): Promise<string> {
    const p = join(root, "publisher-key");
    await runExtensionKeygen(["--out", p]);
    return p;
  }

  function writeManifest(extra: Record<string, unknown>): string {
    const dir = join(root, "ext");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({ id: "a.b", name: "A", version: "1.0.0", entry: "i.js", ...extra }),
    );
    return dir;
  }

  const signed = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8"));

  test("--key with no value reads the default key, which is absent here", async () => {
    const dir = writeManifest({});
    expect(await runExtensionSign([dir, "--key"])).toBe(2);
    expect(stderr()).toContain("could not read key file");
  });

  test("a key file that is not 32 bytes is refused", async () => {
    const dir = writeManifest({});
    const short = join(root, "short-key");
    writeFileSync(short, `${encodeBase64(new Uint8Array(16))}\n`);
    expect(await runExtensionSign([dir, "--key", short])).toBe(2);
    expect(stderr()).toContain("did not decode to 32 bytes");
  });

  test("a publisher with no key receives the signing key's public half", async () => {
    const dir = writeManifest({ publisher: { id: "acme" } });
    expect(await runExtensionSign([dir, "--key", await keyFile()])).toBe(0);
    const pub = (signed(dir)["publisher"] as { key?: string }).key;
    expect(typeof pub).toBe("string");
    expect(typeof signed(dir)["signature"]).toBe("string");
  });

  test("a publisher whose key is already the signing key is signed unchanged", async () => {
    const key = await keyFile();
    const dir = writeManifest({ publisher: { id: "acme" } });
    expect(await runExtensionSign([dir, "--key", key])).toBe(0);
    const first = signed(dir)["publisher"];
    expect(await runExtensionSign([dir, "--key", key])).toBe(0);
    expect(signed(dir)["publisher"]).toEqual(first);
  });

  test("a publisher whose key is another key is refused, naming both fingerprints", async () => {
    const other = encodeBase64(generateEd25519Keypair().pubkey);
    const dir = writeManifest({ publisher: { id: "acme", key: other } });
    expect(await runExtensionSign([dir, "--key", await keyFile()])).toBe(2);
    expect(stderr()).toContain("does not match the signing key");
    expect(stderr()).toContain("manifest key fingerprint");
  });

  test("a publisher key that is not a string is reported as such", async () => {
    const dir = writeManifest({ publisher: { id: "acme", key: 5 } });
    expect(await runExtensionSign([dir, "--key", await keyFile()])).toBe(2);
    expect(stderr()).toContain("(not a string)");
  });

  test("an invalid funding entry stops signing with the field and the reason", async () => {
    const dir = writeManifest({ funding: "nope" });
    expect(await runExtensionSign([dir, "--key", await keyFile()])).toBe(2);
    expect(stderr()).toContain("is invalid");
    expect(stderr()).toContain("fix it before signing");
  });

  test("an unreadable manifest answers 2", async () => {
    expect(await runExtensionSign([join(root, "missing"), "--key", await keyFile()])).toBe(2);
    expect(stderr()).toContain("could not read manifest");
  });
});

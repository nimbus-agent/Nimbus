import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustFeed,
  publisherKeyFingerprint,
  readTrustFeedStatements,
  signTrustStatement,
  verifyTrustFeedPinned,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { readFeedSource, runTrustMaintain, type TrustMaintainEnv } from "./trust-maintain.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const PUB_SEED = new Uint8Array(32).fill(41);
const PUB_KEY = b64(nacl.sign.keyPair.fromSeed(PUB_SEED).publicKey);
const NEXT_KEY = b64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42)).publicKey);
const SHA = "a".repeat(40);
const NOW = new Date("2026-10-27T12:00:00.000Z");

let root: string;
let feed: string;
let keyPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-trust-maintain-"));
  feed = join(root, "feed");
  keyPath = join(root, "keys", "trust-root-key");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function env(releaseCommit: string | undefined = SHA) {
  const out: string[] = [];
  const err: string[] = [];
  const e: TrustMaintainEnv = {
    io: { stdout: (s) => void out.push(s), stderr: (s) => void err.push(s) },
    build: { releaseCommit, version: "10.5.0" },
    now: () => NOW,
  };
  return { e, out: () => out.join(""), err: () => err.join("") };
}

async function run(args: string[], releaseCommit?: string) {
  const h = env(releaseCommit);
  const code = await runTrustMaintain(args, h.e);
  return { code, out: h.out(), err: h.err() };
}

const readFeed = (dir = feed) =>
  parseTrustFeed(new Uint8Array(readFileSync(join(dir, "trust.json"))));

async function init(): Promise<void> {
  const r = await run(["init", feed, "--key", keyPath]);
  expect(r.code).toBe(0);
}

describe("trust maintain init", () => {
  test("a local folder gets the source skeleton and a signed sequence-1 feed; a rerun refuses", async () => {
    const r = await run(["init", feed, "--key", keyPath]);
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(join(feed, "nimbus-trust.json"), "utf8"))).toEqual({
      format: 1,
    });
    for (const d of ["publishers", "requests", "statements"]) {
      expect(existsSync(join(feed, d, ".gitkeep"))).toBe(true);
    }
    const f = readFeed();
    expect(f.sequence).toBe(1);
    expect(f.generatedAt).toBe(NOW.toISOString());
    await verifyTrustFeedPinned(f, f.rootKey);
    expect(r.out).toContain(publisherKeyFingerprint(f.rootKey));
    expect(existsSync(keyPath)).toBe(true);
    const again = await run(["init", feed, "--key", keyPath]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("refusing to overwrite without --force");
    expect((await run(["init", feed, "--key", keyPath, "--force"])).code).toBe(0);
  });

  test("--github writes workflows, README and the site; no trust.json in the source folder", async () => {
    const site = join(root, "site");
    const r = await run(["init", feed, "--key", keyPath, "--github", "--site", site]);
    expect(r.code).toBe(0);
    const sign = readFileSync(join(feed, ".github", "workflows", "trust-sign.yml"), "utf8");
    expect(sign).toContain("mode: trust-sign");
    expect(sign).toContain("environment: trust-signing");
    expect(sign).toContain("secrets.NIMBUS_TRUST_ROOT_KEY");
    expect(sign).toContain(`registry-action@${SHA}`);
    const check = readFileSync(join(feed, ".github", "workflows", "trust-check.yml"), "utf8");
    expect(check).toContain("mode: trust-check");
    expect(check).not.toContain("secrets.");
    expect(readFileSync(join(feed, "README.md"), "utf8")).toContain("Nimbus trust feed");
    expect(existsSync(join(feed, "trust.json"))).toBe(false);
    expect(readFeed(site).sequence).toBe(1);
    expect(existsSync(join(site, ".nojekyll"))).toBe(true);
    expect(r.out).toContain("trust-signing");
  });

  test("refusals: a key inside a pushed folder, overlapping folders, a github-only flag, no pin", async () => {
    const inside = await run(["init", feed, "--key", join(feed, "k")]);
    expect(inside.err).toContain("would be inside");
    const site = join(root, "site");
    const inSite = await run(["init", feed, "--key", join(site, "k"), "--github", "--site", site]);
    expect(inSite.err).toContain("which is pushed to GitHub");
    const overlap = await run([
      "init",
      feed,
      "--key",
      keyPath,
      "--github",
      "--site",
      join(feed, "s"),
    ]);
    expect(overlap.err).toContain("overlaps");
    const stray = await run(["init", feed, "--key", keyPath, "--site", site]);
    expect(stray.err).toContain("--site needs --github");
    const noPin = await run(["init", feed, "--key", keyPath, "--github"], undefined);
    expect(noPin.code).toBe(0); // the env's build still has a SHA; check the explicit no-commit build
    const h = env();
    const code = await runTrustMaintain(
      ["init", join(root, "f2"), "--key", join(root, "k2"), "--github"],
      {
        ...h.e,
        build: { releaseCommit: undefined, version: "10.5.0" },
      },
    );
    expect(code).toBe(2);
    expect(h.err()).toContain("--action-ref");
    expect((await run(["init"])).err).toContain("init needs <dir>");
  });
});

describe("source commands", () => {
  test("verify-publisher writes a sorted publisher file; unverify removes it", async () => {
    await init();
    const keyFile = join(root, "pub.key");
    writeFileSync(keyFile, `${NEXT_KEY}\n`);
    const r = await run([
      "verify-publisher",
      feed,
      "acme",
      "--key",
      PUB_KEY,
      "--key",
      keyFile,
      "--github",
      "acme-dev",
    ]);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(feed, "publishers", "acme.json"), "utf8"));
    expect(written).toEqual({
      publisherId: "acme",
      keys: [PUB_KEY, NEXT_KEY].sort(),
      github: "acme-dev",
    });
    expect((await run(["unverify-publisher", feed, "acme"])).code).toBe(0);
    expect(existsSync(join(feed, "publishers", "acme.json"))).toBe(false);
    expect((await run(["unverify-publisher", feed, "acme"])).err).toContain("is not verified");
  });

  test("verify-publisher refuses a bad key, a bad handle and missing flags", async () => {
    await init();
    expect(
      (await run(["verify-publisher", feed, "acme", "--key", "nope", "--github", "a"])).err,
    ).toContain("neither a public key nor a readable file");
    const notKey = join(root, "not.key");
    writeFileSync(notKey, "hello");
    expect(
      (await run(["verify-publisher", feed, "acme", "--key", notKey, "--github", "a"])).err,
    ).toContain("is not a base64 Ed25519 public key");
    expect(
      (await run(["verify-publisher", feed, "acme", "--key", PUB_KEY, "--github", "-x-"])).code,
    ).toBe(2);
    expect((await run(["verify-publisher", feed, "acme", "--key", PUB_KEY])).err).toContain(
      "needs <dir>",
    );
    expect((await run(["verify-publisher", join(root, "none"), "acme"])).err).toContain(
      "run `nimbus trust maintain init`",
    );
  });

  test("revoke-key and takedown write request files; a takedown needs --publisher", async () => {
    await init();
    const fp = publisherKeyFingerprint(PUB_KEY);
    const revoke = await run(["revoke-key", feed, fp, "--publisher", "acme", "--reason", "leaked"]);
    expect(revoke.code).toBe(0);
    const again = await run(["revoke-key", feed, fp, "--publisher", "acme", "--reason", "leaked"]);
    expect(again.out).toContain("already requested");
    const take = await run([
      "takedown",
      feed,
      "acme/tool@1.0.0",
      "--publisher",
      "acme",
      "--reason",
      "malware",
    ]);
    expect(take.code).toBe(0);
    const { source } = readFeedSource(feed);
    expect(source.requests.map((f) => f.raw)).toContainEqual({
      kind: "extension.takedown",
      extensionId: "acme/tool",
      publisherId: "acme",
      versions: ["1.0.0"],
      reason: "malware",
    });
    expect((await run(["takedown", feed, "acme/tool", "--reason", "x"])).err).toContain(
      "needs --publisher",
    );
    expect((await run(["revoke-key", feed, fp, "--reason", "x"])).err).toContain(
      "needs --publisher",
    );
    expect((await run(["revoke-key", feed])).err).toContain("needs <dir> <fingerprint>");
    expect((await run(["takedown", feed])).err).toContain("needs <dir> <id>[@<version>]");
  });

  test("add-statement copies a publisher-signed statement under its id; refuses others", async () => {
    await init();
    const s = await signTrustStatement(
      {
        kind: "key.rotate",
        publisherId: "acme",
        fromKey: PUB_KEY,
        toKey: NEXT_KEY,
        issuedAt: NOW.toISOString(),
        signerKey: PUB_KEY,
      },
      PUB_SEED,
    );
    const file = join(root, "rotate.json");
    writeFileSync(file, JSON.stringify(s));
    expect((await run(["add-statement", feed, file])).code).toBe(0);
    const { source } = readFeedSource(feed);
    expect(source.statements).toHaveLength(1);
    expect(source.statements[0]?.path).toMatch(/^statements\/[0-9a-f]{64}\.json$/);
    const forged = join(root, "forged.json");
    writeFileSync(
      forged,
      JSON.stringify({
        ...s,
        toKey: b64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43)).publicKey),
      }),
    );
    expect((await run(["add-statement", feed, forged])).err).toContain(
      "not signed by the key it concerns",
    );
    const junk = join(root, "junk.json");
    writeFileSync(junk, "{");
    expect((await run(["add-statement", feed, junk])).err).toContain("is not a statement");
    expect((await run(["add-statement", feed])).err).toContain("needs <dir> <statement file>");
  });
});

describe("plan and sign", () => {
  test("sign builds the next feed from the source; a rerun signs nothing; blocks survive deletion", async () => {
    await init();
    await run(["verify-publisher", feed, "acme", "--key", PUB_KEY, "--github", "acme-dev"]);
    await run([
      "revoke-key",
      feed,
      publisherKeyFingerprint(NEXT_KEY),
      "--publisher",
      "acme",
      "--reason",
      "leaked",
    ]);
    const plan = await run(["plan", feed]);
    expect(plan.out).toContain("verify acme as @acme-dev (added)");
    expect(plan.out).toContain(`revoke key ${publisherKeyFingerprint(NEXT_KEY)} of acme`);
    const signed = await run(["sign", feed, "--key", keyPath]);
    expect(signed.code).toBe(0);
    expect(signed.out).toContain("sequence 2");
    const f = readFeed();
    expect(
      readTrustFeedStatements(f)
        .statements.map((s) => s.kind)
        .sort(),
    ).toEqual(["key.revoke", "publisher.verified"]);
    const rerun = await run(["sign", feed, "--key", keyPath]);
    expect(rerun.out).toContain("Nothing to sign.");
    expect(readFeed().sequence).toBe(2);
    // Un-verify and delete the request: the badge goes, the block stays.
    await run(["unverify-publisher", feed, "acme"]);
    for (const n of readFeedSource(feed).source.requests) rmSync(join(feed, n.path));
    await run(["sign", feed, "--key", keyPath]);
    expect(readTrustFeedStatements(readFeed()).statements.map((s) => s.kind)).toEqual([
      "key.revoke",
    ]);
  });

  test("skipped files are reported with their reason", async () => {
    await init();
    writeFileSync(join(feed, "requests", "broken.json"), "{");
    writeFileSync(
      join(feed, "publishers", "wrong.json"),
      JSON.stringify({ publisherId: "acme", keys: [PUB_KEY], github: "a" }),
    );
    writeFileSync(join(feed, "publishers", "notes.txt"), "ignored");
    const r = await run(["plan", feed]);
    expect(r.out).toContain("Nothing to sign.");
    expect(r.out).toContain("requests/broken.json: not valid JSON");
    expect(r.out).toContain("publishers/wrong.json:");
  });

  test("sign refuses a wrong key, a tampered feed and a --github folder", async () => {
    await init();
    const otherKey = join(root, "other-key");
    writeFileSync(otherKey, `${b64(new Uint8Array(32).fill(5))}\n`);
    expect((await run(["sign", feed, "--key", otherKey])).err).toContain(
      "different key than --key",
    );
    const f = readFeed();
    writeFileSync(join(feed, "trust.json"), JSON.stringify({ ...f, sequence: 9 }));
    expect((await run(["sign", feed, "--key", keyPath])).code).toBe(2);
    const gh = join(root, "gh");
    await run([
      "init",
      gh,
      "--key",
      join(root, "gh-key"),
      "--github",
      "--site",
      join(root, "gh-site"),
    ]);
    expect((await run(["sign", gh, "--key", join(root, "gh-key")])).err).toContain(
      "trust-sign workflow",
    );
    expect((await run(["sign", feed, "extra", "--key", keyPath])).err).toContain(
      "sign needs <dir>",
    );
  });

  test("a missing source directory reads as empty", async () => {
    mkdirSync(feed, { recursive: true });
    expect(readFeedSource(feed).source).toEqual({ publishers: [], requests: [], statements: [] });
  });
});

describe("dispatch", () => {
  test("no or an unknown sub prints usage and exits 2", async () => {
    for (const args of [[], ["nope"]]) {
      const r = await run(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("Usage: nimbus trust maintain init");
    }
  });

  test("an unknown option is a usage error", async () => {
    expect((await run(["plan", feed, "--what"])).err).toContain("unknown option --what");
  });
});

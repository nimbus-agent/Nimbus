import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTrustStatement,
  publicKeyFromSeed,
  publisherKeyFingerprint,
  trustStatementId,
  verifyTrustStatement,
} from "@nimbus-dev/registry-format";

import { type KeyCmdDeps, runExtensionKey } from "./extension-key.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const OLD_SEED = new Uint8Array(32).fill(21);
const NEW_SEED = new Uint8Array(32).fill(22);
const OLD_KEY = b64(publicKeyFromSeed(OLD_SEED));
const NEW_KEY = b64(publicKeyFromSeed(NEW_SEED));

let dir: string;
let out: string[];
let errs: string[];
let deps: KeyCmdDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-extension-key-"));
  writeFileSync(join(dir, "old-key"), `${b64(OLD_SEED)}\n`);
  writeFileSync(join(dir, "new-key"), `${b64(NEW_SEED)}\n`);
  writeFileSync(join(dir, "short-key"), `${b64(new Uint8Array(16))}\n`);
  out = [];
  errs = [];
  deps = {
    cwd: dir,
    now: () => new Date("2026-10-26T12:00:00Z"),
    log: (s) => out.push(s),
    err: (s) => errs.push(s),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = (name: string): string => join(dir, name);
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

describe("nimbus extension key rotate", () => {
  test("writes a key.rotate signed by the old key, named by its statement id", async () => {
    const code = await runExtensionKey(
      ["rotate", "--from", at("old-key"), "--to", at("new-key"), "--publisher", "acme"],
      deps,
    );
    expect(code).toBe(0);
    const s = parseTrustStatement(readJson(at(`${extractId(out)}.json`)));
    expect(s.kind).toBe("key.rotate");
    if (s.kind !== "key.rotate") throw new Error("unreachable");
    expect(s.fromKey).toBe(OLD_KEY);
    expect(s.toKey).toBe(NEW_KEY);
    expect(s.publisherId).toBe("acme");
    expect(verifyTrustStatement(s, {})).toBe("publisher");
    expect(trustStatementId(s)).toBe(extractId(out));
    const text = out.join("");
    expect(text).toContain(publisherKeyFingerprint(OLD_KEY));
    expect(text).toContain(publisherKeyFingerprint(NEW_KEY));
    expect(text).toContain("--statement");
  });

  test("--out names the file; an existing file is refused without --force", async () => {
    const args = ["rotate", "--from", at("old-key"), "--to", at("new-key"), "--publisher", "acme"];
    expect(await runExtensionKey([...args, "--out", at("r.json")], deps)).toBe(0);
    expect(await runExtensionKey([...args, "--out", at("r.json")], deps)).toBe(2);
    expect(errs.join("")).toContain("--force");
    expect(await runExtensionKey([...args, "--out", at("r.json"), "--force"], deps)).toBe(0);
  });

  test("the same key for --from and --to is refused", async () => {
    const code = await runExtensionKey(
      ["rotate", "--from", at("old-key"), "--to", at("old-key"), "--publisher", "acme"],
      deps,
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("same key");
  });
});

describe("nimbus extension key revoke", () => {
  test("writes a key.revoke signed by the key it revokes", async () => {
    const code = await runExtensionKey(
      [
        "revoke",
        "--key",
        at("old-key"),
        "--publisher",
        "acme",
        "--reason",
        "laptop stolen -- rotate",
      ],
      deps,
    );
    expect(code).toBe(0);
    const s = parseTrustStatement(readJson(at(`${extractId(out)}.json`)));
    if (s.kind !== "key.revoke") throw new Error(`expected key.revoke, got ${s.kind}`);
    expect(s.keyFingerprint).toBe(publisherKeyFingerprint(OLD_KEY));
    expect(s.reason).toBe("laptop stolen -- rotate");
    expect(verifyTrustStatement(s, {})).toBe("publisher");
  });

  test("a missing --reason is a usage error", async () => {
    expect(
      await runExtensionKey(["revoke", "--key", at("old-key"), "--publisher", "acme"], deps),
    ).toBe(2);
    expect(errs.join("")).toContain("--reason");
  });
});

describe("refusals", () => {
  test("a key file that is not a 32-byte seed is refused without printing its content", async () => {
    const code = await runExtensionKey(
      ["rotate", "--from", at("short-key"), "--to", at("new-key"), "--publisher", "acme"],
      deps,
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("short-key");
    expect(errs.join("")).not.toContain(b64(new Uint8Array(16)));
  });

  test("a malformed publisher id is refused", async () => {
    const code = await runExtensionKey(
      ["rotate", "--from", at("old-key"), "--to", at("new-key"), "--publisher", "Not Valid!"],
      deps,
    );
    expect(code).toBe(2);
    expect(errs.join("")).toContain("publisher");
  });

  test("unknown subcommands and options are usage errors", async () => {
    expect(await runExtensionKey(["frob"], deps)).toBe(2);
    expect(await runExtensionKey(["rotate", "--bogus", "x"], deps)).toBe(2);
    expect(errs.join("")).toContain("Usage: nimbus extension key");
  });

  test("the private seeds never reach stdout or stderr", async () => {
    await runExtensionKey(
      ["rotate", "--from", at("old-key"), "--to", at("new-key"), "--publisher", "acme"],
      deps,
    );
    await runExtensionKey(
      ["rotate", "--from", at("missing"), "--to", at("new-key"), "--publisher", "acme"],
      deps,
    );
    const all = out.join("") + errs.join("");
    expect(all).not.toContain(b64(OLD_SEED));
    expect(all).not.toContain(b64(NEW_SEED));
  });
});

function extractId(lines: readonly string[]): string {
  const m = /statement id ([0-9a-f]{64})/.exec(lines.join(""));
  if (m?.[1] === undefined) throw new Error(`no statement id in output: ${lines.join("")}`);
  return m[1];
}

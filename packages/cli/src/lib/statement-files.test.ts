import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publicKeyFromSeed,
  type RegistryExtensionEntry,
  type StatementIndex,
  signTrustStatement,
} from "@nimbus-dev/registry-format";

import { admitAllStatements, readStatementArgs } from "./statement-files.ts";

const SEED = new Uint8Array(32).fill(71);
const NEXT_SEED = new Uint8Array(32).fill(72);
const KEY = Buffer.from(publicKeyFromSeed(SEED)).toString("base64");
const NEXT_KEY = Buffer.from(publicKeyFromSeed(NEXT_SEED)).toString("base64");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-statement-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(key: string): RegistryExtensionEntry {
  const hex = "a".repeat(64);
  return {
    publisher: { id: "acme", key },
    versions: {
      "1.0.0": {
        channel: "stable",
        name: "Tool",
        manifest: "m",
        manifestSha256: hex,
        package: "p",
        packageSha256: hex,
        packageSizeBytes: 1,
        entryHash: hex,
        publishedAt: "2026-10-26T12:00:00Z",
      },
    },
  };
}

const INDEX: StatementIndex = { extensions: { "acme/tool": entry(KEY) } };

function rotation() {
  return signTrustStatement(
    {
      kind: "key.rotate",
      issuedAt: "2026-10-26T12:00:00Z",
      signerKey: KEY,
      publisherId: "acme",
      fromKey: KEY,
      toKey: NEXT_KEY,
    },
    SEED,
  );
}

describe("readStatementArgs", () => {
  test("parses each file in order", () => {
    writeFileSync(join(dir, "a.json"), '{"a":1}');
    writeFileSync(join(dir, "b.json"), '{"b":2}');
    expect(readStatementArgs([join(dir, "a.json"), join(dir, "b.json")])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });

  test("names a file that cannot be read, with its error code", () => {
    const missing = join(dir, "missing.json");
    expect(() => readStatementArgs([missing])).toThrow(
      `could not read statement file ${missing}: ENOENT`,
    );
  });

  test("names a file that is not JSON", () => {
    writeFileSync(join(dir, "bad.json"), "{nope");
    expect(() => readStatementArgs([join(dir, "bad.json")])).toThrow("is not valid JSON");
  });

  test("no files is an empty list", () => {
    expect(readStatementArgs([])).toEqual([]);
  });
});

describe("admitAllStatements", () => {
  test("returns the admission when every statement is admitted", async () => {
    const r = await rotation();
    const a = admitAllStatements(INDEX, [r]);
    expect(a.admitted).toEqual([r]);
  });

  test("refuses naming each statement: a short id when it has one, the bare reason when not", async () => {
    const stranger = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NEXT_KEY,
        publisherId: "acme",
        fromKey: NEXT_KEY,
        toKey: KEY,
      },
      NEXT_SEED,
    );
    let message = "";
    try {
      admitAllStatements(INDEX, [stranger, { kind: "key.rotate" }]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("the registry would not admit these statements:");
    expect(message).toMatch(/[0-9a-f]{12}: signing key/);
    expect(message).toContain("not a valid statement");
  });
});

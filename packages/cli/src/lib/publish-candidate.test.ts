import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PACKAGE_BYTES, RegistryError } from "@nimbus-dev/registry-format";
import { buildPublishCandidate } from "./publish-candidate.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nimbus-publish-candidate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function refusal(tgz: string): Promise<RegistryError> {
  let caught: unknown;
  try {
    await buildPublishCandidate(tgz, dir, "stable");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RegistryError);
  return caught as RegistryError;
}

describe("buildPublishCandidate refuses before extracting", () => {
  test("a package over the size cap is ERR_REGISTRY_TOO_LARGE, read from its size alone", async () => {
    const tgz = join(dir, "big.tgz");
    writeFileSync(tgz, "");
    // Sparse where the filesystem allows it: only the size is read.
    truncateSync(tgz, MAX_PACKAGE_BYTES + 1);
    expect((await refusal(tgz)).code).toBe("ERR_REGISTRY_TOO_LARGE");
  });

  test("an archive that is not a tarball is a refusal, not a raw tar error", async () => {
    const tgz = join(dir, "junk.tgz");
    writeFileSync(tgz, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xde, 0xad, 0xbe, 0xef]));
    expect((await refusal(tgz)).code).toBe("ERR_REGISTRY_EXTRACT_FAILED");
  });
});

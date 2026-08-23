import { describe, expect, test } from "bun:test";

import { nimbusSpawn, spawnViaBun, spawnViaNode } from "./nimbus-spawn.ts";

const IMPLS = [
  ["nimbusSpawn (runtime-selected)", nimbusSpawn],
  ["spawnViaBun", spawnViaBun],
  // The suite runs under Bun, so without an explicit case this branch — the one the standalone
  // npx artifact actually uses — would never execute.
  ["spawnViaNode", spawnViaNode],
] as const;

describe.each(IMPLS)("%s", (_label, nimbusSpawn) => {
  test("captures stdout and a zero exit", async () => {
    const r = await nimbusSpawn([process.execPath, "-e", "console.log('hi')"], {});
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("captures stderr and a non-zero exit", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.error('boom'); process.exit(3)"],
      {},
    );
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  test("passes env through", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "console.log(process.env.NIMBUS_TEST_VAL)"],
      { NIMBUS_TEST_VAL: "set" },
    );
    expect(r.stdout.trim()).toBe("set");
  });

  test("an empty command is refused rather than spawned", async () => {
    const r = await nimbusSpawn([], {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("empty command");
  });

  test("a command that does not exist resolves with an error, never rejects", async () => {
    const r = await nimbusSpawn(["definitely-not-a-real-binary-xyz"], {});
    expect(r.code).not.toBe(0);
  });

  test("output above 1MB is NOT truncated — the execFile maxBuffer trap", async () => {
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('x'.repeat(2_000_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(2_000_000);
  });

  test("multi-byte UTF-8 spanning chunk boundaries is not corrupted", async () => {
    // The previous case is pure ASCII and cannot catch per-chunk decoding. This one can: a large
    // run of 3-byte characters guarantees some character straddles a pipe chunk boundary.
    const r = await nimbusSpawn(
      [process.execPath, "-e", "process.stdout.write('豆'.repeat(400_000))"],
      {},
    );
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(400_000);
    // U+FFFD REPLACEMENT CHARACTER is what per-chunk decoding produces at a split boundary.
    expect(r.stdout).not.toContain("�");
  });
});

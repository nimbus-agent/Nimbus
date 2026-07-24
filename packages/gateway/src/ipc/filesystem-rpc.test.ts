import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchFilesystemRpc, FilesystemRpcError } from "./filesystem-rpc.ts";

type HitOf<V> = { kind: "hit"; value: V };

describe("dispatchFilesystemRpc", () => {
  test("miss for an unknown method", async () => {
    const out = await dispatchFilesystemRpc("foo.bar", {}, { configDir: tmpdir() });
    expect(out.kind).toBe("miss");
  });

  test("rejects a non-object params", async () => {
    await expect(
      dispatchFilesystemRpc("filesystem.ensureRoot", "nope", { configDir: tmpdir() }),
    ).rejects.toBeInstanceOf(FilesystemRpcError);
  });

  test("rejects a missing path", async () => {
    await expect(
      dispatchFilesystemRpc("filesystem.ensureRoot", {}, { configDir: tmpdir() }),
    ).rejects.toBeInstanceOf(FilesystemRpcError);
  });

  test("rejects a path that does not resolve", async () => {
    const cfg = mkdtempSync(join(tmpdir(), "fsrpc-"));
    await expect(
      dispatchFilesystemRpc(
        "filesystem.ensureRoot",
        { path: join(tmpdir(), "definitely-missing-xyz-42") },
        { configDir: cfg },
      ),
    ).rejects.toBeInstanceOf(FilesystemRpcError);
  });

  test("rejects a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsrpc-nogit-"));
    await expect(
      dispatchFilesystemRpc("filesystem.ensureRoot", { path: dir }, { configDir: dir }),
    ).rejects.toBeInstanceOf(FilesystemRpcError);
  });

  test("rejects a path that is a file, not a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsrpc-file-"));
    const file = join(dir, "a.ts");
    writeFileSync(file, "x\n");
    await expect(
      dispatchFilesystemRpc("filesystem.ensureRoot", { path: file }, { configDir: dir }),
    ).rejects.toBeInstanceOf(FilesystemRpcError);
  });

  test("registers a git repo idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fsrpc-git-"));
    mkdirSync(join(dir, ".git"));
    const cfg = mkdtempSync(join(tmpdir(), "fsrpc-cfg-"));

    const first = (await dispatchFilesystemRpc(
      "filesystem.ensureRoot",
      { path: dir },
      { configDir: cfg },
    )) as HitOf<{ path: string; added: boolean }>;
    expect(first.kind).toBe("hit");
    expect(first.value.added).toBe(true);

    const second = (await dispatchFilesystemRpc(
      "filesystem.ensureRoot",
      { path: dir },
      { configDir: cfg },
    )) as HitOf<{ path: string; added: boolean }>;
    expect(second.value.added).toBe(false);
    expect(second.value.path).toBe(first.value.path);
  });
});

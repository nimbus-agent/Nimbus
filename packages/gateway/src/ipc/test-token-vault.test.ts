import { describe, expect, test } from "bun:test";
import { CLIP_TOKENS_KEY, createSeededTokenVault } from "./test-token-vault.ts";

describe("createSeededTokenVault", () => {
  test("serves the seeded token blob under the one key every bearer surface reads", async () => {
    const seeded = JSON.stringify([{ token: "t1", scopes: ["agents"] }]);
    const vault = createSeededTokenVault(seeded);
    expect(CLIP_TOKENS_KEY).toBe("http_api.web_clipper_tokens");
    expect(await vault.get(CLIP_TOKENS_KEY)).toBe(seeded);
    // Absent keys answer null (the NimbusVault contract), never undefined.
    expect(await vault.get("http_api.other")).toBeNull();
  });

  test("set and delete mutate THIS vault's store, and listKeys reflects them", async () => {
    const vault = createSeededTokenVault('["legacy-bare-token"]');
    await vault.set("http_api.extra", "v");
    expect(await vault.get("http_api.extra")).toBe("v");
    expect(await vault.listKeys()).toEqual([CLIP_TOKENS_KEY, "http_api.extra"]);

    await vault.delete(CLIP_TOKENS_KEY);
    expect(await vault.get(CLIP_TOKENS_KEY)).toBeNull();
    expect(await vault.listKeys()).toEqual(["http_api.extra"]);
  });

  test("listKeys filters by prefix, and an unmatched prefix yields an empty list", async () => {
    const vault = createSeededTokenVault("[]");
    await vault.set("github.pat", "x");
    expect(await vault.listKeys("http_api.")).toEqual([CLIP_TOKENS_KEY]);
    expect(await vault.listKeys("github.")).toEqual(["github.pat"]);
    expect(await vault.listKeys("nope.")).toEqual([]);
  });

  test("two vaults never share state — each harness gets its own seed", async () => {
    const a = createSeededTokenVault('["a"]');
    const b = createSeededTokenVault('["b"]');
    await a.set("only.in.a", "1");
    expect(await b.get("only.in.a")).toBeNull();
    expect(await a.get(CLIP_TOKENS_KEY)).toBe('["a"]');
    expect(await b.get(CLIP_TOKENS_KEY)).toBe('["b"]');
  });
});

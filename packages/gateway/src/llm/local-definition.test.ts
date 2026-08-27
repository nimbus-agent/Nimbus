import { describe, expect, test } from "bun:test";

const FILES = [
  "packages/gateway/src/llm/router.ts",
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/ipc/llm-rpc.ts",
];

describe("local-ness has exactly one definition", () => {
  test("no file re-derives the local provider set from literals", async () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = await Bun.file(f).text();
      // The three copies this refactor collapsed: a literal pair of local ids.
      if (/\["ollama",\s*"llamacpp"\]/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("isLocal is read from the provider, never inferred from an id", async () => {
    const src = await Bun.file("packages/gateway/src/llm/router.ts").text();
    expect(src).not.toContain("LOCAL_PROVIDER_IDS");
  });
});

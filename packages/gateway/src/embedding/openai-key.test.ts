import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeInMemoryVault } from "../../test/helpers/in-memory-vault.ts";
import { processEnvDelete, processEnvGet, processEnvSet } from "../platform/env-access.ts";
import { OPENAI_EMBEDDING_VAULT_KEY, resolveOpenAIEmbeddingKey } from "./openai-key.ts";

describe("resolveOpenAIEmbeddingKey", () => {
  let saved: string | undefined;
  let warnings: string[];
  const logger = { warn: (msg: string) => warnings.push(msg) };

  beforeEach(() => {
    saved = processEnvGet("OPENAI_API_KEY");
    processEnvDelete("OPENAI_API_KEY");
    warnings = [];
  });
  afterEach(() => {
    if (saved === undefined) processEnvDelete("OPENAI_API_KEY");
    else processEnvSet("OPENAI_API_KEY", saved);
  });

  test("reads the Vault key silently when the environment is empty", async () => {
    const vault = makeInMemoryVault();
    await vault.set(OPENAI_EMBEDDING_VAULT_KEY, "  sk-vault  ");
    expect(await resolveOpenAIEmbeddingKey(vault, logger)).toBe("sk-vault");
    expect(warnings).toEqual([]);
  });

  test("keeps the environment fallback, ahead of the Vault, and warns naming the Vault key", async () => {
    const vault = makeInMemoryVault();
    await vault.set(OPENAI_EMBEDDING_VAULT_KEY, "sk-vault");
    processEnvSet("OPENAI_API_KEY", "sk-env-secret");
    expect(await resolveOpenAIEmbeddingKey(vault, logger)).toBe("sk-env-secret");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(OPENAI_EMBEDDING_VAULT_KEY);
    // The warning names the variable, never its value.
    expect(warnings[0]).not.toContain("sk-env-secret");
  });

  test("returns an empty string when neither source has a key", async () => {
    expect(await resolveOpenAIEmbeddingKey(makeInMemoryVault(), logger)).toBe("");
    expect(warnings).toEqual([]);
  });
});

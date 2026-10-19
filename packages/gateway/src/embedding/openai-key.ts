import type { Logger } from "pino";
import { processEnvGet } from "../platform/env-access.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** The Vault key the OpenAI embedder reads when the environment does not supply one. */
export const OPENAI_EMBEDDING_VAULT_KEY = "openai.api_key";

/**
 * The OpenAI API key for embeddings: `OPENAI_API_KEY` from the environment first, then the Vault's
 * `openai.api_key`; `""` when neither is set.
 *
 * The environment fallback is KEPT deliberately (removing it would silently stop OpenAI embeddings
 * for anyone relying on it, unlike the LLM adapters, which dropped theirs in v5.0.0 as a breaking
 * change), but every use of it logs a warning: a key in the process environment is inherited by
 * every child the gateway does not scrub, and the Vault is where Nimbus keeps credentials.
 *
 * One definition for the four sites that used to read the variable inline (the routing and plain
 * embedding runtimes, and `index.reembed`'s resolve and preflight).
 */
export async function resolveOpenAIEmbeddingKey(
  vault: NimbusVault,
  logger: Pick<Logger, "warn">,
): Promise<string> {
  const envKey = processEnvGet("OPENAI_API_KEY")?.trim() ?? "";
  if (envKey !== "") {
    logger.warn(
      `OpenAI embedding key read from the OPENAI_API_KEY environment variable. Store it in the ` +
        `Vault instead (nimbus vault set ${OPENAI_EMBEDDING_VAULT_KEY} <key>) and unset the variable.`,
    );
    return envKey;
  }
  const v = await vault.get(OPENAI_EMBEDDING_VAULT_KEY);
  return typeof v === "string" ? v.trim() : "";
}

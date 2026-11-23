import { parseBool, parseIntDec, parseString } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

export type NimbusEmbeddingToml = {
  enabled: boolean;
  provider: "local" | "openai" | "hybrid";
  model: string;
  chunkTokens: number;
  chunkOverlapTokens: number;
  backfillBatchSize: number;
  pauseOnBattery: boolean;
};

export const DEFAULT_NIMBUS_EMBEDDING_TOML: NimbusEmbeddingToml = {
  enabled: true,
  provider: "local",
  model: "all-MiniLM-L6-v2",
  chunkTokens: 256,
  chunkOverlapTokens: 32,
  backfillBatchSize: 50,
  pauseOnBattery: true,
};

function setEmbeddingEnabled(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.enabled = b;
  }
}

function setEmbeddingPauseOnBattery(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const b = parseBool(valRaw);
  if (b !== undefined) {
    out.pauseOnBattery = b;
  }
}

function setEmbeddingProvider(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const p = parseString(valRaw).toLowerCase();
  if (p === "local" || p === "openai" || p === "hybrid") {
    out.provider = p;
  }
}

function setEmbeddingPositiveInt(
  out: Partial<NimbusEmbeddingToml>,
  valRaw: string,
  field: "chunkTokens" | "backfillBatchSize",
): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n > 0) {
    out[field] = n;
  }
}

function setEmbeddingOverlapTokens(out: Partial<NimbusEmbeddingToml>, valRaw: string): void {
  const n = parseIntDec(valRaw);
  if (n !== undefined && n >= 0) {
    out.chunkOverlapTokens = n;
  }
}

function applyNimbusEmbeddingKey(
  out: Partial<NimbusEmbeddingToml>,
  key: string,
  valRaw: string,
): void {
  switch (key) {
    case "enabled":
      setEmbeddingEnabled(out, valRaw);
      break;
    case "provider":
      setEmbeddingProvider(out, valRaw);
      break;
    case "model":
      out.model = parseString(valRaw);
      break;
    case "chunk_tokens":
      setEmbeddingPositiveInt(out, valRaw, "chunkTokens");
      break;
    case "chunk_overlap_tokens":
      setEmbeddingOverlapTokens(out, valRaw);
      break;
    case "backfill_batch_size":
      setEmbeddingPositiveInt(out, valRaw, "backfillBatchSize");
      break;
    case "pause_on_battery":
      setEmbeddingPauseOnBattery(out, valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlEmbeddingSection(source: string): Partial<NimbusEmbeddingToml> {
  const out: Partial<NimbusEmbeddingToml> = {};
  forEachSectionEntry(source, "[embedding]", (key, valRaw) => {
    applyNimbusEmbeddingKey(out, key, valRaw);
  });
  return out;
}

function parseNimbusEmbeddingLoaded(raw: string): NimbusEmbeddingToml {
  return structuredClone({
    ...DEFAULT_NIMBUS_EMBEDDING_TOML,
    ...parseNimbusTomlEmbeddingSection(raw),
  });
}

export function loadNimbusEmbeddingFromPath(tomlPath: string): NimbusEmbeddingToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_EMBEDDING_TOML, parseNimbusEmbeddingLoaded);
}

export function loadNimbusEmbeddingFromConfigDir(configDir: string): NimbusEmbeddingToml {
  return loadTomlSectionFromConfig(
    configDir,
    "embedding",
    DEFAULT_NIMBUS_EMBEDDING_TOML,
    parseNimbusEmbeddingLoaded,
  );
}

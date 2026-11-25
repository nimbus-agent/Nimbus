import { DEFAULT_OPENAPI_CONFIG, parseOpenapiToml } from "../connectors/openapi-indexer-config.ts";
import { loadTomlSectionFromConfig } from "./nimbus-toml.ts";

/** `[openapi]` over the layered snapshot, for `nimbus config explain`. */
export function loadNimbusOpenapiFromConfigDir(configDir: string): unknown {
  return loadTomlSectionFromConfig(configDir, "openapi", DEFAULT_OPENAPI_CONFIG, parseOpenapiToml);
}

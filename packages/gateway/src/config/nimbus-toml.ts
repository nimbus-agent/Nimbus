import type { ServiceConfig } from "../metrics/dora-config.ts";
import { assertLayersReadable, layeredConfigText } from "./layered-config.ts";
import { parseNimbusPagerdutyToml } from "./nimbus-toml/pagerduty-identity.ts";
import { parseNimbusCiServiceToml, parseNimbusDoraToml } from "./service-config-toml.ts";

export {
  DEFAULT_NIMBUS_AGENTS_TOML,
  DEFAULT_NIMBUS_PERSONA_TOML,
  loadNimbusAgentsFromConfigDir,
  loadNimbusAgentsFromPath,
  loadNimbusPersonaFromConfigDir,
  loadNimbusPersonaFromPath,
  type NimbusAgentsToml,
  type NimbusPersonaToml,
  type PersonaIssue,
  type PersonaTone,
  type PersonaVoice,
  parseNimbusAgentsToml,
  parseNimbusPersonaToml,
  type SynthesisMode,
} from "./nimbus-toml/agents-persona.ts";
export {
  DEFAULT_NIMBUS_AUDIT_TOML,
  DEFAULT_NIMBUS_SECURITY_TOML,
  DEFAULT_NIMBUS_USER_TOML,
  loadNimbusAuditFromConfigDir,
  loadNimbusAuditFromPath,
  loadNimbusSecurityFromConfigDir,
  loadNimbusSecurityFromPath,
  loadNimbusUserFromConfigDir,
  loadNimbusUserFromPath,
  type NimbusAuditToml,
  type NimbusSecurityToml,
  type NimbusUserToml,
  parseNimbusAuditToml,
  parseNimbusSecurityToml,
  parseNimbusUserToml,
} from "./nimbus-toml/audit-security-user.ts";
export {
  DEFAULT_NIMBUS_BRIEFS_TOML,
  DEFAULT_NIMBUS_DECISIONS_TOML,
  DEFAULT_NIMBUS_GLOSSARY_TOML,
  loadNimbusBriefsFromConfigDir,
  loadNimbusBriefsFromPath,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  type NimbusBriefsToml,
  type NimbusDecisionsToml,
  type NimbusGlossaryToml,
  parseNimbusBriefsToml,
  parseNimbusDecisionsToml,
  parseNimbusGlossaryToml,
} from "./nimbus-toml/briefs-glossary-decisions.ts";
export {
  type CuLane,
  DEFAULT_NIMBUS_CODE_EXECUTION_TOML,
  DEFAULT_NIMBUS_COMPUTER_USE_TOML,
  KNOWN_CU_LANES,
  KNOWN_EXEC_RUNTIMES,
  loadNimbusCodeExecutionFromConfigDir,
  loadNimbusCodeExecutionFromPath,
  loadNimbusComputerUseFromConfigDir,
  type NimbusCodeExecutionToml,
  type NimbusComputerUseToml,
  parseNimbusCodeExecutionToml,
  parseNimbusComputerUseToml,
} from "./nimbus-toml/code-execution-computer-use.ts";
export {
  DEFAULT_NIMBUS_EMBEDDING_TOML,
  loadNimbusEmbeddingFromConfigDir,
  loadNimbusEmbeddingFromPath,
  type NimbusEmbeddingToml,
  parseNimbusTomlEmbeddingSection,
} from "./nimbus-toml/embedding.ts";
export {
  DEFAULT_NIMBUS_EXTENSIONS_RUNTIME,
  DEFAULT_NIMBUS_EXTENSIONS_TOML,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusExtensionsFromPath,
  loadNimbusExtensionsRuntimeFromConfigDir,
  type NimbusExtensionsToml,
  parseNimbusExtensionsRuntime,
  parseNimbusExtensionsToml,
} from "./nimbus-toml/extensions.ts";
export {
  DEFAULT_NIMBUS_AUTOMATION_TOML,
  DEFAULT_NIMBUS_FEDERATION_TOML,
  loadNimbusAutomationFromConfigDir,
  loadNimbusAutomationFromPath,
  loadNimbusFederationFromConfigDir,
  loadNimbusFederationFromPath,
  type NimbusAutomationToml,
  type NimbusFederationToml,
  parseNimbusAutomationToml,
  parseNimbusFederationToml,
} from "./nimbus-toml/federation-automation.ts";
export {
  DEFAULT_NIMBUS_LAN_TOML,
  loadNimbusLanFromConfigDir,
  loadNimbusLanFromPath,
  type NimbusLanToml,
  parseNimbusLanToml,
} from "./nimbus-toml/lan.ts";
export {
  DEFAULT_NIMBUS_LLM_TOML,
  loadNimbusLlmFromConfigDir,
  loadNimbusLlmFromPath,
  loadNimbusLlmPartialFromPath,
  type NimbusLlmLocalRoute,
  type NimbusLlmRemoteVendor,
  type NimbusLlmToml,
  parseNimbusTomlLlmSection,
} from "./nimbus-toml/llm.ts";
export {
  DEFAULT_NIMBUS_NEGOTIATE_TOML,
  DEFAULT_NIMBUS_OWNERSHIP_TOML,
  DEFAULT_NIMBUS_PREMORTEM_TOML,
  loadNimbusNegotiateFromConfigDir,
  loadNimbusNegotiateFromPath,
  loadNimbusOwnershipFromConfigDir,
  loadNimbusPremortemFromConfigDir,
  type NimbusNegotiateToml,
  type NimbusOwnershipToml,
  type NimbusPremortemToml,
  parseNimbusNegotiateToml,
  parseNimbusOwnershipToml,
  parseNimbusPremortemToml,
} from "./nimbus-toml/ownership-premortem-negotiate.ts";
export {
  DEFAULT_NIMBUS_IDENTITY_TOML,
  DEFAULT_NIMBUS_PAGERDUTY_TOML,
  loadNimbusIdentityFromConfigDir,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPagerdutyFromPath,
  type NimbusIdentityToml,
  type NimbusPagerdutyToml,
  parseNimbusIdentityToml,
  parseNimbusPagerdutyToml,
} from "./nimbus-toml/pagerduty-identity.ts";
export {
  DEFAULT_NIMBUS_SHARE_HTTP_SINK,
  DEFAULT_NIMBUS_TRIBAL_TOML,
  loadNimbusPreflightFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusTribalFromConfigDir,
  type NimbusShareHttpSink,
  type NimbusTribalToml,
  nimbusTribalConfigUnreadable,
  type PreflightCommandConfig,
  type PreflightConfig,
  parseNimbusShareHttpSink,
  parseNimbusTribalToml,
  parsePreflightConfig,
  type TribalConfluenceTarget,
  type TribalMatchMode,
  type TribalNotionTarget,
} from "./nimbus-toml/preflight-tribal-share.ts";
export {
  DEFAULT_NIMBUS_CHATOPS_TOML,
  DEFAULT_NIMBUS_SCIM_TOML,
  loadNimbusChatopsFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusQuorumFromPath,
  loadNimbusScimFromConfigDir,
  type NimbusChatopsToml,
  type NimbusScimToml,
  parseNimbusChatopsToml,
  parseNimbusScimToml,
  parseQuorumConfig,
  type QuorumConfig,
  type QuorumRule,
} from "./nimbus-toml/quorum-scim-chatops.ts";
// The per-section schemas, defaults and parsers live in `./nimbus-toml/<section>.ts`; this file is
// the facade that keeps every importer's `./nimbus-toml.ts` path unchanged. Each re-export is
// listed by name so a module-internal helper never becomes public surface.
export { loadTomlSectionFromConfig } from "./nimbus-toml/shared.ts";
export {
  DEFAULT_NIMBUS_TOOL_GENERATION_TOML,
  loadNimbusToolGenerationFromConfigDir,
  type NimbusToolGenerationToml,
  parseNimbusToolGenerationToml,
  type ToolgenDraftingMode,
} from "./nimbus-toml/tool-generation.ts";
export {
  DEFAULT_NIMBUS_UPDATER_TOML,
  DEFAULT_NIMBUS_VOICE_TOML,
  loadNimbusUpdaterFromConfigDir,
  loadNimbusUpdaterFromPath,
  loadNimbusVoiceFromConfigDir,
  loadNimbusVoiceFromPath,
  type NimbusUpdaterToml,
  type NimbusVoiceToml,
  parseNimbusTomlUpdaterSection,
  parseNimbusTomlVoiceSection,
  parseNimbusUpdaterToml,
} from "./nimbus-toml/voice-updater.ts";
// Re-export the DORA / CI service-config surface so external importers
// (http-server.ts, ipc/server/dispatchers.ts, config + metrics tests) keep
// working through `./nimbus-toml.ts` unchanged.
export * from "./service-config-toml.ts";

// The DORA / CI service-config machinery (parsing + materialization) lives in
// `./service-config-toml.ts` and is re-exported from this module via the
// `export *` barrel near the top. `loadNimbusServiceConfigsFromConfigDir`
// stays here because it bridges that machinery with the `[pagerduty]` section
// parser (`parseNimbusPagerdutyToml`) defined above — keeping it here avoids a
// `service-config-toml.ts` → `nimbus-toml.ts` circular import.
export function loadNimbusServiceConfigsFromConfigDir(
  configDir: string,
): Map<string, ServiceConfig> {
  assertLayersReadable(configDir);
  const raw = layeredConfigText(configDir);
  if (raw === null) return new Map();
  const dora = parseNimbusDoraToml(raw);
  const ci = parseNimbusCiServiceToml(raw);
  const pagerdutyCfg = parseNimbusPagerdutyToml(raw);
  const aliases = pagerdutyCfg.severityP1Aliases;
  const merged: Map<string, ServiceConfig> = new Map();
  for (const [id, cfg] of dora.entries()) {
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  for (const [id, cfg] of ci.entries()) {
    if (merged.has(id)) {
      process.stderr.write(
        `[ci.service.${id}] and [metrics.dora.${id}] both define service '${id}'; ` +
          `using [ci.service.${id}].\n`,
      );
    }
    merged.set(id, { ...cfg, severityP1Aliases: aliases });
  }
  // `depends_on` is a direct edge list across the two tables, so a dangling target can only be seen here.
  // A warning, never an error: the target may simply not be configured yet (IC4's cascade skips it).
  for (const [id, cfg] of merged.entries()) {
    for (const dep of cfg.dependsOn) {
      if (!merged.has(dep)) {
        process.stderr.write(`[${id}] depends_on names service '${dep}', which is not configured; ignored.
`);
      }
    }
  }
  return merged;
}

export {
  type ConnectorCredentialConfig,
  type ConnectorsConfig,
  loadNimbusConnectorsFromConfigDir,
  parseNimbusConnectorsToml,
  TEAM_CREDENTIAL_CONNECTORS,
  type TeamCredentialConnector,
} from "./nimbus-toml-connectors.ts";

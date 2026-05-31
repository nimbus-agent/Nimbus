export { createNimbusEngineAgent } from "./agent.ts";
export {
  bindConsentChannel,
  formatConsentPrompt,
  HITL_REQUIRED,
  redactPayloadForConsentDisplay,
  ToolExecutor,
} from "./executor.ts";
export { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
export { planFromIntent } from "./planner.ts";
export { type ClassifiedIntent, classifyIntent, type IntentClass } from "./router.ts";
export { runAsk } from "./run-ask.ts";
export type {
  ActionResult,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

export const ENGINE_SUBSYSTEM_ID = "nimbus-engine" as const;

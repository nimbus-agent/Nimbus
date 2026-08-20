import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRequestContext = {
  sessionId?: string | undefined;
  /**
   * Disclosure sentences recorded by negation tools during this turn, drained and appended by
   * `runConversationalAgent`. Created LAZILY by `recordNegationDisclosure` rather than
   * initialised where the store is built: `ipc/server/inline-handlers.ts` constructs the store
   * in THREE places (`engine.ask` at :96, `workflow.run` at :215, and the `engine.askStream`
   * dispatcher at :350), and a field that had to be initialised at all three would eventually
   * be initialised at fewer.
   */
  negationDisclosures?: string[];
};

export const agentRequestContext = new AsyncLocalStorage<AgentRequestContext>();

export function getAgentRequestSessionId(): string | undefined {
  return agentRequestContext.getStore()?.sessionId;
}

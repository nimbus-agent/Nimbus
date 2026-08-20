import { AsyncLocalStorage } from "node:async_hooks";

export type AgentRequestContext = {
  sessionId?: string | undefined;
  /**
   * Disclosure sentences recorded by negation tools during this turn, drained and appended by
   * `runConversationalAgent`. Created LAZILY by `recordNegationDisclosure` rather than
   * initialised where the store is built: `ipc/server/inline-handlers.ts` constructs the store
   * in TWO places (`engine.ask` and the `engine.askStream` dispatcher), and a field that had to
   * be initialised at both would eventually be initialised at one.
   */
  negationDisclosures?: string[];
};

export const agentRequestContext = new AsyncLocalStorage<AgentRequestContext>();

export function getAgentRequestSessionId(): string | undefined {
  return agentRequestContext.getStore()?.sessionId;
}

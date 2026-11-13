// packages/gateway/src/connectors/connector-writes/agent-door-notice.ts
// The one sentence said in the enable prompt, the enable reply and `status` until the agent door
// reads the owner's list (Phase 28 AD3a-1). A module of its own so the consent prompt's renderer can
// import it without pulling in the door's eligibility code. AD3a-2 deletes this file, which fails
// the test that pins all three surfaces on purpose.

export const AGENT_DOOR_NOT_ENFORCED_NOTICE =
  "This list is recorded now and takes effect in a later release: until then what an agent can propose is unchanged.";

import { describe, expect, test } from "bun:test";

import {
  agentRequestContext,
  drainPointInTimeFacts,
  getAgentRequestPointInTimeMs,
  recordPointInTimeFacts,
} from "./agent-request-context.ts";

const FACTS = { atMs: 5, historyStartMs: null, gapCount: 1 };

describe("point-in-time request context", () => {
  test("outside a turn: no instant, recording is a no-op, draining is empty", () => {
    expect(getAgentRequestPointInTimeMs()).toBeUndefined();
    recordPointInTimeFacts(FACTS);
    expect(drainPointInTimeFacts()).toEqual([]);
  });

  test("inside a turn: the instant is readable and facts accumulate then drain once", () => {
    agentRequestContext.run({ pointInTimeMs: 7 }, () => {
      expect(getAgentRequestPointInTimeMs()).toBe(7);
      recordPointInTimeFacts(FACTS);
      recordPointInTimeFacts({ ...FACTS, gapCount: 4 });
      expect(drainPointInTimeFacts()).toEqual([FACTS, { ...FACTS, gapCount: 4 }]);
      expect(drainPointInTimeFacts()).toEqual([]);
    });
  });
});

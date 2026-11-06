// Proves the I2 HITL gate covers the Apple connector's four write actions. Each runs under its
// own `apple.*` action type (the connector-write registry pairs a tool with its type, I53: an
// `apple_*` tool under the generic `email.send` is refused), so the things to prove are that those
// four types are gated and that the gate fires (consent BEFORE dispatch; reject => no dispatch).
// The calendar delete is a Wave 4 write: its consent is the typed confirmation.
import { describe, expect, test } from "bun:test";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { HITL_REQUIRED, ToolExecutor } from "./executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel, PlannedAction } from "./types.ts";

// The four write actions apple's tools resolve to. `mcpToolId` carries the
// concrete apple_* tool id (dispatch resolves by `payload.mcpToolId ?? action.type`),
// while the executor gate keys on `action.type` alone (I3).
const APPLE_WRITES: ReadonlyArray<{ type: string; mcpToolId: string; input: object }> = [
  { type: "apple.mail.send", mcpToolId: "apple_mail_send", input: { to: "x@y.z" } },
  { type: "apple.mail.draft.create", mcpToolId: "apple_mail_draft_create", input: { to: "x@y.z" } },
  {
    type: "apple.calendar.event.create",
    mcpToolId: "apple_calendar_event_create",
    input: { to: "x@y.z" },
  },
  {
    type: "apple.calendar.event.delete",
    mcpToolId: "apple_calendar_event_delete",
    input: { href: "/cal/event-1.ics" },
  },
];

function harness(approve: boolean): {
  exec: ToolExecutor;
  order: string[];
  prompts: string[];
  dispatchCount: () => number;
} {
  const order: string[] = [];
  const prompts: string[] = [];
  let dispatched = 0;
  const consent: ConsentChannel = {
    requestApproval: async (prompt: string) => {
      order.push("consent");
      prompts.push(prompt);
      return approve;
    },
    // The Wave 4 delete: the typed confirmation is its consent.
    requestConfirmedApproval: async (req) => {
      order.push("consent");
      prompts.push(req.prompt);
      return { approved: approve, typed: req.confirmText };
    },
  };
  const audit: AuditSink = { recordAudit: () => {} };
  const connectors: ConnectorDispatcher = {
    dispatch: async (_a: PlannedAction) => {
      order.push("dispatch");
      dispatched += 1;
      return { ok: true };
    },
  };
  return {
    exec: new ToolExecutor(consent, audit, connectors, undefined, NULL_EGRESS_SINK),
    order,
    prompts,
    dispatchCount: () => dispatched,
  };
}

describe("Apple connector writes ride the existing I2 HITL gate", () => {
  for (const { type, mcpToolId, input } of APPLE_WRITES) {
    test(`${type} is in the HITL_REQUIRED frozen set`, () => {
      expect(HITL_REQUIRED.has(type)).toBe(true);
    });

    test(`${type} (${mcpToolId}): consent is prompted BEFORE dispatch, then dispatches on approval`, async () => {
      const h = harness(true);
      const res = await h.exec.execute({ type, payload: { mcpToolId, input } });
      expect(res.status).toBe("ok");
      // The consent prompt strictly precedes the connector dispatch.
      expect(h.order).toEqual(["consent", "dispatch"]);
      expect(h.dispatchCount()).toBe(1);
    });

    test(`${type} (${mcpToolId}): rejection returns "rejected" and NEVER dispatches`, async () => {
      const h = harness(false);
      const res = await h.exec.execute({ type, payload: { mcpToolId, input } });
      expect(res.status).toBe("rejected");
      expect(h.order).toEqual(["consent"]);
      expect(h.dispatchCount()).toBe(0);
    });
  }
});

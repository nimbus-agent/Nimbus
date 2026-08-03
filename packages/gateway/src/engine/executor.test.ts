import { describe, expect, test } from "bun:test";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { ToolExecutor } from "./executor.ts";
import type {
  ActionResult,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

function deps(over: { approve?: boolean; onDispatch?: () => void; sink?: EgressSink }): {
  consent: ConsentChannel;
  audit: AuditSink;
  connectors: ConnectorDispatcher;
  appended: EgressEntry[];
} {
  const appended: EgressEntry[] = [];
  const consent: ConsentChannel = {
    requestApproval: async () => over.approve ?? true,
  };
  const audit: AuditSink = { recordAudit: () => {} };
  const connectors: ConnectorDispatcher = {
    dispatch: async (_a: PlannedAction) => {
      over.onDispatch?.();
      return { ok: true };
    },
  };
  return { consent, audit, connectors, appended };
}

describe("I29 — egress ledger append-before-dispatch (executor wiring)", () => {
  test("a row is appended BEFORE connectors.dispatch is called", async () => {
    const order: string[] = [];
    const appended: EgressEntry[] = [];
    const sink: EgressSink = {
      append: (e) => {
        order.push("append");
        appended.push(e);
      },
    };
    const d = deps({ onDispatch: () => order.push("dispatch") });
    const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
    await exec.execute({ type: "search.run", payload: {} });
    expect(order).toEqual(["append", "dispatch"]);
    expect(appended[0]?.resultStatus).toBe("authorized");
  });

  test("a denied HITL action appends a blocked row and NEVER dispatches", async () => {
    const dispatched = { count: 0 };
    const appended: EgressEntry[] = [];
    const sink: EgressSink = { append: (e) => appended.push(e) };
    const d = deps({
      approve: false,
      onDispatch: () => {
        dispatched.count += 1;
      },
    });
    const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
    const res: ActionResult = await exec.execute({ type: "email.send", payload: {} });
    expect(res.status).toBe("rejected");
    expect(dispatched.count).toBe(0);
    expect(appended[0]?.resultStatus).toBe("blocked");
    expect(appended[0]?.hitlStatus).toBe("rejected");
  });

  test("an append failure ABORTS the action (dispatch never runs, error propagates)", async () => {
    const dispatched = { count: 0 };
    const sink: EgressSink = {
      append: () => {
        throw new Error("ledger write failed");
      },
    };
    const d = deps({
      onDispatch: () => {
        dispatched.count += 1;
      },
    });
    const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, sink);
    await expect(exec.execute({ type: "search.run", payload: {} })).rejects.toThrow(
      /ledger write failed/,
    );
    expect(dispatched.count).toBe(0);
  });

  test("with NULL_EGRESS_SINK, the executor still gates + dispatches (no ledger row recorded)", async () => {
    const d = deps({});
    const exec = new ToolExecutor(d.consent, d.audit, d.connectors, undefined, NULL_EGRESS_SINK);
    const res = await exec.execute({ type: "search.run", payload: {} });
    expect(res.status).toBe("ok");
  });
});

import { describe, expect, test } from "bun:test";
import {
  parseSlackInteractive,
  type SlackInteractive,
  SlackSocketAdapter,
  type SocketLike,
} from "./slack-socket-adapter.ts";

/** Real-shaped Socket Mode `block_actions` envelope (a click on a card button). */
function blockActions(
  action: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    type: "interactive",
    envelope_id: "env-a",
    payload: {
      type: "block_actions",
      user: { id: "U_ALICE", username: "alice", team_id: "T1" },
      trigger_id: "13345224609.738474920.8088930838d88f008e0",
      actions: [
        {
          action_id: "nimbus_confirm_open",
          block_id: "b1",
          type: "button",
          value: "req-1",
          action_ts: "1.2",
        },
      ],
      ...extra,
    },
    ...(Object.keys(action).length === 0 ? {} : { accepts_response_payload: false }),
  };
}

function viewSubmission(overrides: Record<string, unknown> = {}, state?: unknown): unknown {
  return {
    type: "interactive",
    envelope_id: "env-s",
    payload: {
      type: "view_submission",
      user: { id: "U_ALICE" },
      view: {
        id: "V1",
        type: "modal",
        callback_id: "nimbus_confirm",
        private_metadata: "req-1",
        state: state ?? {
          values: {
            confirm: { typed: { type: "plain_text_input", value: "github/merge acme/api#12" } },
          },
        },
        ...overrides,
      },
    },
  };
}

describe("parseSlackInteractive", () => {
  test("a Confirm click gives open with the trigger id", () => {
    expect(parseSlackInteractive(blockActions({}))).toEqual({
      kind: "open",
      requestId: "req-1",
      userId: "U_ALICE",
      triggerId: "13345224609.738474920.8088930838d88f008e0",
    });
  });

  test("a Reject click gives reject (no trigger id needed)", () => {
    const frame = blockActions({}) as { payload: { actions: Record<string, unknown>[] } };
    frame.payload.actions[0] = { action_id: "nimbus_confirm_reject", value: "req-9" };
    expect(parseSlackInteractive(frame)).toEqual({
      kind: "reject",
      requestId: "req-9",
      userId: "U_ALICE",
    });
  });

  test("a view submission gives submit with the typed text verbatim (no trim, no case change)", () => {
    const frame = viewSubmission(
      {},
      {
        values: { confirm: { typed: { type: "plain_text_input", value: "  A/b é " } } },
      },
    );
    expect(parseSlackInteractive(frame)).toEqual({
      kind: "submit",
      requestId: "req-1",
      userId: "U_ALICE",
      typed: "  A/b é ",
    });
  });

  test("a null or missing input value gives submit with no typed field", () => {
    const frame = viewSubmission(
      {},
      {
        values: { confirm: { typed: { type: "plain_text_input", value: null } } },
      },
    );
    expect(parseSlackInteractive(frame)).toEqual({
      kind: "submit",
      requestId: "req-1",
      userId: "U_ALICE",
    });
  });

  test.each([
    ["not an object", null],
    ["a string", "x"],
    ["not interactive", { type: "events_api", payload: {} }],
    ["no payload", { type: "interactive" }],
    ["no user", { type: "interactive", payload: { type: "block_actions" } }],
    [
      "an empty user id",
      { type: "interactive", payload: { type: "block_actions", user: { id: "" } } },
    ],
    [
      "an unknown payload type",
      { type: "interactive", payload: { type: "shortcut", user: { id: "U" } } },
    ],
    ["no actions", { type: "interactive", payload: { type: "block_actions", user: { id: "U" } } }],
    [
      "an action with no value",
      {
        type: "interactive",
        payload: {
          type: "block_actions",
          user: { id: "U" },
          actions: [{ action_id: "nimbus_confirm_open" }],
        },
      },
    ],
    [
      "another app's action",
      {
        type: "interactive",
        payload: {
          type: "block_actions",
          user: { id: "U" },
          trigger_id: "t",
          actions: [{ action_id: "other", value: "v" }],
        },
      },
    ],
    [
      "an open with no trigger id",
      {
        type: "interactive",
        payload: {
          type: "block_actions",
          user: { id: "U" },
          actions: [{ action_id: "nimbus_confirm_open", value: "r" }],
        },
      },
    ],
  ])("%s gives undefined", (_name, frame) => {
    expect(parseSlackInteractive(frame)).toBeUndefined();
  });

  test.each([
    ["another callback id", viewSubmission({ callback_id: "other" })],
    ["no request id", viewSubmission({ private_metadata: "" })],
    ["no view", { type: "interactive", payload: { type: "view_submission", user: { id: "U" } } }],
    ["no state", viewSubmission({ state: undefined }, {})],
    ["no input block", viewSubmission({}, { values: { other: {} } })],
  ])("a view submission with %s gives undefined", (_name, frame) => {
    expect(parseSlackInteractive(frame)).toBeUndefined();
  });
});

class FakeSocket implements SocketLike {
  msgCb?: (raw: string) => void;
  readonly sent: string[] = [];
  onMessage(cb: (raw: string) => void): void {
    this.msgCb = cb;
  }
  onClose(_cb: () => void): void {}
  send(raw: string): void {
    this.sent.push(raw);
  }
  close(): void {}
  emit(frame: unknown): void {
    this.msgCb?.(JSON.stringify(frame));
  }
}

describe("SlackSocketAdapter interactive frames", () => {
  async function started(): Promise<{
    sock: FakeSocket;
    got: SlackInteractive[];
    order: string[];
  }> {
    const sock = new FakeSocket();
    const got: SlackInteractive[] = [];
    const order: string[] = [];
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    adapter.onInteractive(async (i) => {
      order.push(`handled:${sock.sent.length}`);
      got.push(i);
    });
    await adapter.start();
    return { sock, got, order };
  }

  test("acks first, then hands the parsed event to the handler", async () => {
    const { sock, got, order } = await started();
    sock.emit(blockActions({}));
    await new Promise((r) => setTimeout(r, 5));
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "env-a" })]);
    expect(got).toHaveLength(1);
    expect(order).toEqual(["handled:1"]); // the ack was already sent when the handler ran
  });

  test("a redelivered envelope id is acked but handled once", async () => {
    const { sock, got } = await started();
    sock.emit(blockActions({}));
    sock.emit(blockActions({}));
    await new Promise((r) => setTimeout(r, 5));
    expect(sock.sent).toHaveLength(2);
    expect(got).toHaveLength(1);
  });

  test("an unparseable interactive frame is acked and ignored", async () => {
    const { sock, got } = await started();
    sock.emit({ type: "interactive", envelope_id: "env-x", payload: { type: "shortcut" } });
    await new Promise((r) => setTimeout(r, 5));
    expect(sock.sent).toEqual([JSON.stringify({ envelope_id: "env-x" })]);
    expect(got).toHaveLength(0);
  });

  test("with no handler wired, a valid frame is acked and dropped", async () => {
    const sock = new FakeSocket();
    const adapter = new SlackSocketAdapter({
      openSocket: async () => ({ url: "wss://x" }),
      socketFactory: () => sock,
    });
    await adapter.start();
    sock.emit(blockActions({}));
    await new Promise((r) => setTimeout(r, 5));
    expect(sock.sent).toHaveLength(1);
  });

  test("a frame with no envelope id is handled (no dedupe key to check)", async () => {
    const { sock, got } = await started();
    const frame = blockActions({}) as Record<string, unknown>;
    delete frame["envelope_id"];
    sock.emit(frame);
    sock.emit(frame);
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toHaveLength(2);
  });
});

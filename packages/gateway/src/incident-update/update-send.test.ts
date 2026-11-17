import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import { buildOwnerPushExecutor } from "../engine/run-ask.ts";
import type { PlannedAction } from "../engine/types.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { IncidentError } from "../incident/assemble.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { ChatopsPolicy } from "../policy/types.ts";
import {
  type SendOutcome,
  sendIncidentUpdate,
  UPDATE_TEXT_MAX,
  type UpdateDestination,
} from "./update-send.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const LISTENING: ChatopsPolicy = {
  channels: new Map([["C0OPS", { namespace: "ops", unmapped: "deny", notify: [] }]]),
  ownership: new Map(),
} as unknown as ChatopsPolicy;

const SLACK: UpdateDestination = { platform: "slack", channel: "C0STATUS" };
const TEAMS: UpdateDestination = {
  platform: "teams",
  teamId: "team-1",
  channelId: "19:abc@thread.tacv2",
};
const TEXT = "Incident update: Payments latency\nStatus: Ongoing\n";

type Rig = {
  readonly recordId: string;
  readonly prompts: string[];
  readonly dispatched: PlannedAction[];
  readonly audits: { actionType: string; hitlStatus: string; actionJson: string }[];
  readonly egress: EgressEntry[];
  send(dest: UpdateDestination, text?: string, recordId?: string): Promise<SendOutcome>;
};

function rig(
  o: { readonly approve?: boolean; readonly chatops?: () => ChatopsPolicy | undefined } = {},
): Rig {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const stored = upsertIncidentRecord(db, {
    record: buildRecord({ itemId: "pagerduty:PDS" }),
    markdown: "# x",
    recordSha256: "b".repeat(64),
    citedServices: ["pagerduty"],
    nowMs: 1,
  });
  const prompts: string[] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Rig["audits"] = [];
  const egress: EgressEntry[] = [];
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      prompts.push(p.prompt);
      return { approved: o.approve ?? true, answerSource: "human" };
    },
    requestConfirmedConsent: async () => {
      throw new Error("a channel post is not a typed-confirm write");
    },
    rejectAllPending: () => {},
    pendingCount: () => 0,
  };
  const executor = buildOwnerPushExecutor({
    clientId: "cli-1",
    consentCoordinator: coordinator,
    audit: {
      recordAudit: (e) =>
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        }),
    },
    dispatcher: {
      dispatch: async (a) => {
        dispatched.push(a);
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
    },
    egressSink: { append: (e) => egress.push(e) },
    policyHitl: NO_POLICY_OVERLAY,
  });
  return {
    recordId: stored.recordId,
    prompts,
    dispatched,
    audits,
    egress,
    send: (dest, text = TEXT, recordId = stored.recordId) =>
      sendIncidentUpdate(
        { db, executor, chatops: o.chatops ?? (() => NO_CHATOPS) },
        recordId,
        dest,
        text,
      ),
  };
}

describe("sendIncidentUpdate", () => {
  test("an approved Slack send posts ONE message as the owner's own linked action", async () => {
    const r = rig();
    expect(await r.send(SLACK)).toEqual({ outcome: "sent" });
    expect(r.dispatched).toHaveLength(1);
    const a = r.dispatched[0] as PlannedAction;
    expect(a.type).toBe("slack.message.post");
    expect(a.origin).toBeUndefined();
    expect(a.proposer).toBeUndefined();
    expect(a.provenance).toBeUndefined();
    expect(a.incident).toEqual({ id: r.recordId, version: 1 });
    expect(a.payload?.["input"]).toEqual({ channel: "C0STATUS", text: TEXT });
    expect(r.prompts).toHaveLength(1);
    const row = r.audits.find((x) => x.actionType === "slack.message.post");
    expect(row?.hitlStatus).toBe("approved");
    expect(row?.actionJson.startsWith(`{"incident":{"id":"${r.recordId}","version":1}`)).toBe(true);
    expect(r.egress).toHaveLength(1);
  });

  test("a Teams send posts a text body to the channel", async () => {
    const r = rig();
    expect(await r.send(TEAMS)).toEqual({ outcome: "sent" });
    const a = r.dispatched[0] as PlannedAction;
    expect(a.type).toBe("teams.message.post");
    expect(a.payload?.["input"]).toEqual({
      teamId: "team-1",
      channelId: "19:abc@thread.tacv2",
      body: TEXT,
      contentType: "text",
    });
  });

  test("a denial posts nothing", async () => {
    const r = rig({ approve: false });
    const out = await r.send(SLACK);
    expect(out.outcome).toBe("denied");
    expect(r.dispatched).toHaveLength(0);
    expect(r.audits.find((x) => x.actionType === "slack.message.post")?.hitlStatus).toBe(
      "rejected",
    );
  });

  test("a broadcast mention, a ChatOps channel and unreadable ChatOps bindings refuse before any prompt", async () => {
    const cases: ReadonlyArray<[Rig, UpdateDestination, string]> = [
      [rig(), SLACK, "Heads up <!here>"],
      [rig({ chatops: () => LISTENING }), { platform: "slack", channel: "C0OPS" }, TEXT],
      [rig({ chatops: () => undefined }), SLACK, TEXT],
      [
        rig({
          chatops: () => {
            throw new Error("policy unreadable");
          },
        }),
        SLACK,
        TEXT,
      ],
    ];
    for (const [r, dest, text] of cases) {
      const out = await r.send(dest, text);
      expect(out.outcome).toBe("refused");
      expect(r.prompts).toHaveLength(0);
      expect(r.dispatched).toHaveLength(0);
      expect(r.audits).toHaveLength(0);
      expect(r.egress).toHaveLength(0);
    }
  });

  test("an empty or over-long text refuses before any prompt", async () => {
    const r = rig();
    expect((await r.send(SLACK, "  \n")).outcome).toBe("refused");
    const long = await r.send(SLACK, "x".repeat(UPDATE_TEXT_MAX + 1));
    expect(long).toMatchObject({ outcome: "refused", code: "ERR_INCIDENT_UPDATE_TOO_LONG" });
    expect(r.prompts).toHaveLength(0);
  });

  test("an unknown record is a typed error before anything else", async () => {
    const r = rig();
    await expect(r.send(SLACK, TEXT, "inc_ffffffffffffffff")).rejects.toBeInstanceOf(IncidentError);
    expect(r.prompts).toHaveLength(0);
  });
});

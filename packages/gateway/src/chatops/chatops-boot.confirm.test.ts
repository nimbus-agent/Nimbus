import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { listEgress } from "../egress/egress-verify.ts";
import { EgressAppendFailedError } from "../egress/model-egress.ts";
import type { PlannedAction } from "../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  buildChatopsBoot,
  CHATOPS_CONFIRM_UNSUPPORTED_REPLY,
  CHATOPS_CONFIRM_USE_FORM_REPLY,
  type ChatopsBootDeps,
} from "./chatops-boot.ts";
import { getChatopsApprovalContext } from "./chatops-request-context.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";
import type { SocketLike } from "./transport/slack-socket-adapter.ts";

class FakeVault implements NimbusVault {
  private readonly store = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }
  delete(_key: string): Promise<void> {
    throw new Error("unused");
  }
  listKeys(_prefix?: string): Promise<string[]> {
    throw new Error("unused");
  }
}

let db: Database;
let vault: NimbusVault;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = new FakeVault();
});
afterEach(() => {
  db.close();
});

const EMAILS: Record<string, string> = {
  U_BOB: "bob@acme.com",
  U_ALICE: "alice@acme.com",
  U_CAROL: "carol@acme.com",
  "29:alice": "alice@acme.com",
  "29:bob": "bob@acme.com",
};
const SCIM: Record<string, { externalId: string; email: string; active: boolean; issuer: string }> =
  {
    "bob@acme.com": { externalId: "ext-bob", email: "bob@acme.com", active: true, issuer: "idp" },
    "alice@acme.com": {
      externalId: "ext-alice",
      email: "alice@acme.com",
      active: true,
      issuer: "idp",
    },
    "carol@acme.com": {
      externalId: "ext-carol",
      email: "carol@acme.com",
      active: true,
      issuer: "idp",
    },
  };

const POLICY: EnforcedPolicy = {
  retentionDays: 30,
  retentionMinDays: 0,
  hitlRequired: new Set<string>(),
  quorum: new Map(),
  capabilitiesDisabled: new Set(),
  chatops: {
    channels: new Map([
      ["C0", { namespace: "project:pay", unmapped: "refuse" as const, notify: [] }],
      ["19:conv", { namespace: "project:pay", unmapped: "refuse" as const, notify: [] }],
    ]),
    ownership: new Map([["payment-service", "alice@acme.com"]]),
  },
};

class FakeSocket implements SocketLike {
  private msgCb: ((raw: string) => void) | undefined;
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

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const WAVE4 =
  "@nimbus run github.pr.merge service=payment-service owner=acme repo=api pullNumber=42";

interface Post {
  platform: string;
  channel: string;
  text: string;
  blocks?: unknown;
  attachments?: unknown;
}

interface Harness {
  socket: FakeSocket;
  posts: Post[];
  opens: { trigger_id: string; view: Record<string, unknown> }[];
  dispatched: PlannedAction[];
  audits: { actionType: string; hitlStatus: string; actionJson: string }[];
  errors: { fields: Record<string, unknown>; msg: string }[];
  boot: Awaited<ReturnType<typeof buildChatopsBoot>>;
  /** Make the next `slack_views_open` call throw this. */
  failOpenWith: { error?: Error };
}

async function harness(opts: { teams?: boolean; overrides?: Partial<ChatopsBootDeps> } = {}) {
  const socket = new FakeSocket();
  const posts: Post[] = [];
  const opens: Harness["opens"] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Harness["audits"] = [];
  const errors: Harness["errors"] = [];
  const failOpenWith: Harness["failOpenWith"] = {};
  const runTool: RunChatopsTool = (platform, toolId, args) => {
    if (toolId === "slack_socket_open") return Promise.resolve({ url: "wss://fake" });
    if (toolId === "slack_user_info") {
      const email = EMAILS[(args as { user: string }).user];
      return Promise.resolve(email === undefined ? { user: {} } : { user: { profile: { email } } });
    }
    if (toolId === "teams_user_info") {
      const email = EMAILS[(args as { userId: string }).userId];
      return Promise.resolve(email === undefined ? {} : { mail: email });
    }
    if (toolId === "slack_chat_post" || toolId === "teams_chat_post") {
      const a = args as Record<string, unknown>;
      posts.push({
        platform,
        channel: String(a["channel"] ?? a["conversationId"]),
        text: String(a["text"]),
        ...(a["blocks"] === undefined ? {} : { blocks: a["blocks"] }),
        ...(a["attachments"] === undefined ? {} : { attachments: a["attachments"] }),
      });
      return Promise.resolve({ ok: true });
    }
    if (toolId === "slack_views_open") {
      if (failOpenWith.error !== undefined) return Promise.reject(failOpenWith.error);
      opens.push(args as Harness["opens"][number]);
      return Promise.resolve({ ok: true });
    }
    throw new Error(`unexpected tool ${toolId}`);
  };
  const deps: ChatopsBootDeps = {
    cfg: {
      enabled: true,
      slackEnabled: opts.teams !== true,
      teamsEnabled: opts.teams === true,
      botVaultEntry: "chatops-bot",
      identityCacheTtlSeconds: 900,
      teamsBotAppId: opts.teams === true ? "app-1" : "",
    },
    policyGate: { enforced: () => POLICY },
    identity: { findScimByEmail: (e) => SCIM[e], isOperatorValid: () => true },
    runTool,
    db,
    vault,
    audit: {
      recordAudit: (e) =>
        audits.push({
          actionType: e.actionType,
          hitlStatus: e.hitlStatus,
          actionJson: e.actionJson,
        }),
    },
    dispatcher: {
      dispatch: (action) => {
        dispatched.push(action);
        return Promise.resolve({ rolledBack: true });
      },
    },
    egressSink: { append: () => {} },
    socketFactory: () => socket,
    validateTeamsJwt: () => Promise.resolve(true),
    log: () => {},
    logError: (fields, msg) => errors.push({ fields, msg }),
    ...opts.overrides,
  };
  const boot = await buildChatopsBoot(deps);
  return { socket, posts, opens, dispatched, audits, errors, boot, failOpenWith } as Harness;
}

function mention(channel: string, user: string, text: string, ts: string): unknown {
  return {
    type: "events_api",
    envelope_id: `env-${ts}`,
    payload: { event: { type: "app_mention", channel, user, text, ts } },
  };
}

function click(user: string, actionId: string, requestId: string, env: string): unknown {
  return {
    type: "interactive",
    envelope_id: env,
    payload: {
      type: "block_actions",
      user: { id: user },
      trigger_id: `trig-${env}`,
      actions: [{ action_id: actionId, value: requestId }],
    },
  };
}

function submitFrame(user: string, requestId: string, typed: string, env: string): unknown {
  return {
    type: "interactive",
    envelope_id: env,
    payload: {
      type: "view_submission",
      user: { id: user },
      view: {
        callback_id: "nimbus_confirm",
        private_metadata: requestId,
        state: { values: { confirm: { typed: { type: "plain_text_input", value: typed } } } },
      },
    },
  };
}

/** The request id on the Slack card's first button. */
function requestIdOf(post: Post | undefined): string {
  const blocks = post?.blocks as { elements?: { value?: string }[] }[] | undefined;
  return blocks?.[1]?.elements?.[0]?.value ?? "";
}

function confirmTextOf(view: Record<string, unknown> | undefined): string {
  const blocks = view?.["blocks"] as { text?: { text: string } }[];
  const line = blocks[0]?.text?.text.split("\n")[1] ?? "";
  return line.replace("To approve, type exactly: ", "");
}

async function slackCard(h: Harness): Promise<{ requestId: string }> {
  h.socket.emit(mention("C0", "U_BOB", WAVE4, "w4"));
  await until(() => h.posts.some((p) => p.blocks !== undefined));
  const card = h.posts.find((p) => p.blocks !== undefined);
  return { requestId: requestIdOf(card) };
}

describe("ChatOps typed confirmation: Slack (Phase 9.7 D0c)", () => {
  test("Confirm opens a ledgered modal; the owner's exact text dispatches the write", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    const card = h.posts.find((p) => p.blocks !== undefined);
    expect(card?.channel).toBe("C0");
    expect(card?.text).toContain("in the form opened by Confirm.");
    expect(h.dispatched).toEqual([]);

    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "e1"));
    await until(() => h.opens.length === 1);
    expect(h.opens[0]?.trigger_id).toBe("trig-e1");
    expect(h.opens[0]?.view["private_metadata"]).toBe(requestId);
    // I29: one chatops.confirmModal row, hashed channel, view bytes.
    const modalRow = listEgress(db, { limit: 20 }).filter(
      (r) => r.method === "chatops.confirmModal",
    );
    expect(modalRow).toHaveLength(1);
    expect(modalRow[0]?.destination).toBe("slack");

    const confirmText = confirmTextOf(h.opens[0]?.view);
    expect(confirmText.length).toBeGreaterThan(0);
    h.socket.emit(submitFrame("U_ALICE", requestId, confirmText, "e2"));
    await until(() => h.dispatched.length === 1);
    expect(h.dispatched[0]?.type).toBe("github.pr.merge");
    const row = h.audits.find((a) => a.actionType === "github.pr.merge");
    expect(row?.hitlStatus).toBe("approved");
    expect(JSON.parse(row?.actionJson ?? "{}").confirm).toBe("matched");
    await h.boot.service.stop();
  });

  test("wrong text: denied, audited as mismatched, nothing dispatched", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "e1"));
    await until(() => h.opens.length === 1);
    const confirmText = confirmTextOf(h.opens[0]?.view);
    h.socket.emit(submitFrame("U_ALICE", requestId, `${confirmText} `, "e2"));
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(h.dispatched).toEqual([]);
    const row = h.audits.find((a) => a.actionType === "github.pr.merge");
    expect(row?.hitlStatus).toBe("rejected");
    const json = JSON.parse(row?.actionJson ?? "{}");
    expect(json.confirm).toBe("mismatched");
    await h.boot.service.stop();
  });

  test("a submit with no string value reaches the executor as a mismatch", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit({
      type: "interactive",
      envelope_id: "e9",
      payload: {
        type: "view_submission",
        user: { id: "U_ALICE" },
        view: {
          callback_id: "nimbus_confirm",
          private_metadata: requestId,
          state: { values: { confirm: { typed: { value: null } } } },
        },
      },
    });
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(JSON.parse(h.audits[0]?.actionJson ?? "{}").confirm).toBe("mismatched");
    expect(h.dispatched).toEqual([]);
    await h.boot.service.stop();
  });

  test("a non-owner Confirm opens no modal; a non-owner submit and reject spend nothing; the owner then succeeds", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);

    h.socket.emit(click("U_BOB", "nimbus_confirm_open", requestId, "n1"));
    h.socket.emit(click("U_CAROL", "nimbus_confirm_open", requestId, "n2"));
    h.socket.emit(click("U_EVE", "nimbus_confirm_open", requestId, "n3")); // unmapped
    h.socket.emit(submitFrame("U_BOB", requestId, "anything", "n4"));
    h.socket.emit(click("U_BOB", "nimbus_confirm_reject", requestId, "n5"));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.opens).toEqual([]);
    expect(h.audits.filter((a) => a.actionType === "github.pr.merge")).toEqual([]);

    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "o1"));
    await until(() => h.opens.length === 1);
    h.socket.emit(submitFrame("U_ALICE", requestId, confirmTextOf(h.opens[0]?.view), "o2"));
    await until(() => h.dispatched.length === 1);
    await h.boot.service.stop();
  });

  test("the Reject button from the owner rejects; a replayed click finds nothing", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(click("U_ALICE", "nimbus_confirm_reject", requestId, "r1"));
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(h.audits.find((a) => a.actionType === "github.pr.merge")?.hitlStatus).toBe("rejected");
    expect(h.dispatched).toEqual([]);
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "r2"));
    await new Promise((r) => setTimeout(r, 40));
    expect(h.opens).toEqual([]);
    await h.boot.service.stop();
  });

  test("a text approve on a confirm card does not approve or spend it: the bot points to the form once", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus approve", "t1"));
    await until(() => h.posts.some((p) => p.text === CHATOPS_CONFIRM_USE_FORM_REPLY));
    expect(h.dispatched).toEqual([]);
    expect(h.audits.filter((a) => a.actionType === "github.pr.merge")).toEqual([]);
    // an unmapped user's approve gets no hint
    const before = h.posts.length;
    h.socket.emit(mention("C0", "U_EVE", "@nimbus approve", "t2"));
    await new Promise((r) => setTimeout(r, 40));
    expect(h.posts).toHaveLength(before);
    // the card is still live: the form still works
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "t3"));
    await until(() => h.opens.length === 1);
    h.socket.emit(submitFrame("U_ALICE", requestId, confirmTextOf(h.opens[0]?.view), "t4"));
    await until(() => h.dispatched.length === 1);
    await h.boot.service.stop();
  });

  test("a text reject from the owner rejects; from a non-owner it leaves the card live", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(mention("C0", "U_BOB", "@nimbus reject", "x1"));
    h.socket.emit(mention("C0", "U_EVE", "@nimbus reject", "x2"));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.audits.filter((a) => a.actionType === "github.pr.merge")).toEqual([]);
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus reject", "x3"));
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(h.audits.find((a) => a.actionType === "github.pr.merge")?.hitlStatus).toBe("rejected");
    expect(h.dispatched).toEqual([]);
    // the card is spent; a late open finds nothing
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "x4"));
    await new Promise((r) => setTimeout(r, 30));
    expect(h.opens).toEqual([]);
    await h.boot.service.stop();
  });

  test("a views.open connector failure is logged (missing_scope named), the card stays live, and a retry works", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.failOpenWith.error = new Error("slack views.open: missing_scope");
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "f1"));
    await until(() => h.errors.length === 1);
    expect(h.errors[0]?.fields["reason"]).toBe("missing_scope");
    h.failOpenWith.error = new Error("expired_trigger");
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "f2"));
    await until(() => h.errors.length === 2);
    expect(h.errors[1]?.fields["reason"]).toBe("failed");

    delete h.failOpenWith.error;
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "f3"));
    await until(() => h.opens.length === 1);
    h.socket.emit(submitFrame("U_ALICE", requestId, confirmTextOf(h.opens[0]?.view), "f4"));
    await until(() => h.dispatched.length === 1);
    await h.boot.service.stop();
  });

  test("a ledger failure on the modal open is contained: logged, nothing opened, card live", async () => {
    const h = await harness();
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    // Drop the ledger table: the modal's append now throws EgressAppendFailedError.
    db.exec("DROP TABLE egress_ledger");
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "l1"));
    await until(() => h.errors.length === 1);
    expect(h.errors[0]?.fields["err"]).toBeInstanceOf(EgressAppendFailedError);
    expect(h.opens).toEqual([]);
    expect(h.dispatched).toEqual([]);
    await h.boot.service.stop();
  });

  test("a plain Wave 1-3 card is unchanged: text only, no blocks, a text approve dispatches", async () => {
    const h = await harness();
    await h.boot.service.start();
    h.socket.emit(
      mention("C0", "U_BOB", "@nimbus run deployment.rollback service=payment-service", "p1"),
    );
    await until(() => h.posts.some((p) => p.text.includes("Approval needed")));
    const card = h.posts.find((p) => p.text.includes("Approval needed"));
    expect(card?.blocks).toBeUndefined();
    expect(card?.text).toContain("Reply Approve/Reject.");
    h.socket.emit(mention("C0", "U_ALICE", "@nimbus approve", "p2"));
    await until(() => h.dispatched.length === 1);
    await h.boot.service.stop();
  });

  test("a confirm text over 512 characters posts no card: refused, not delegated, nothing dispatched", async () => {
    const h = await harness();
    await h.boot.service.start();
    h.socket.emit(
      mention(
        "C0",
        "U_BOB",
        `@nimbus run github.pr.merge service=payment-service owner=acme repo=${"r".repeat(600)} pullNumber=42`,
        "big",
      ),
    );
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(h.posts.some((p) => p.blocks !== undefined)).toBe(false);
    expect(h.dispatched).toEqual([]);
    expect(h.audits.find((a) => a.actionType === "github.pr.merge")?.hitlStatus).toBe("rejected");
    await h.boot.service.stop();
  });

  test("the executor's own identity check failing falls back to a channel that cannot collect typed text: the fixed unsupported reply", async () => {
    // The mapper and the executor share `isOperatorValid`; only the executor's call runs inside
    // the request context, so this fails the I20 check alone, after the owner answered correctly.
    let failInExecutor = false;
    const h = await harness({
      overrides: {
        identity: {
          findScimByEmail: (e) => SCIM[e],
          isOperatorValid: () => !(failInExecutor && getChatopsApprovalContext() !== undefined),
        },
      },
    });
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "u1"));
    await until(() => h.opens.length === 1);
    failInExecutor = true;
    h.socket.emit(submitFrame("U_ALICE", requestId, confirmTextOf(h.opens[0]?.view), "u2"));
    await until(() => h.posts.some((p) => p.text === CHATOPS_CONFIRM_UNSUPPORTED_REPLY));
    expect(h.dispatched).toEqual([]);
    expect(
      JSON.parse(h.audits.find((a) => a.actionType === "github.pr.merge")?.actionJson ?? "{}")
        .confirm,
    ).toBe("unsupported_channel");
    await h.boot.service.stop();
  });

  test("an owner deprovisioned after the card cannot answer it: the submit is ignored and the card stays live", async () => {
    let active = true;
    const h = await harness({
      overrides: {
        identity: {
          findScimByEmail: (e) => {
            const scim = SCIM[e];
            return scim === undefined || e !== "alice@acme.com" ? scim : { ...scim, active };
          },
          isOperatorValid: () => true,
        },
      },
    });
    await h.boot.service.start();
    const { requestId } = await slackCard(h);
    h.socket.emit(click("U_ALICE", "nimbus_confirm_open", requestId, "d1"));
    await until(() => h.opens.length === 1);
    const text = confirmTextOf(h.opens[0]?.view);
    active = false;
    h.socket.emit(submitFrame("U_ALICE", requestId, text, "d2"));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.dispatched).toEqual([]);
    expect(h.audits.filter((a) => a.actionType === "github.pr.merge")).toEqual([]);
    await h.boot.service.stop();
  });
});

describe("ChatOps typed confirmation: Teams (Phase 9.7 D0c)", () => {
  async function teamsCard(h: Harness): Promise<{ requestId: string; confirmText: string }> {
    // The request activity resolves only when the write is decided, so it is not awaited.
    void h.boot.teamsSurface?.onActivity({
      type: "message",
      id: "a-req",
      serviceUrl: "https://smba.example/emea/",
      from: { id: "29:bob" },
      conversation: { id: "19:conv" },
      text: WAVE4,
    });
    await until(() => h.posts.some((p) => p.attachments !== undefined));
    const card = h.posts.find((p) => p.attachments !== undefined);
    interface TeamsAtt {
      content: { actions: { data: { nimbusConfirm: string } }[]; body: { text?: string }[] };
    }
    const att = (card?.attachments as TeamsAtt[] | undefined)?.at(0);
    const requestId = att?.content.actions[0]?.data.nimbusConfirm ?? "";
    const instruction = att?.content.body[1]?.text ?? "";
    // Undo the Markdown escaping the card applies, for the display-only comparison below.
    const confirmText = instruction
      .replace("To approve, type exactly: ", "")
      .replaceAll(/\\([*_~`[\]()#])/g, "$1");
    return { requestId, confirmText };
  }

  const submit = (
    user: string,
    requestId: string,
    verdict: string,
    typed: unknown,
    id: string,
  ): unknown => ({
    type: "message",
    id,
    from: { id: user },
    conversation: { id: "19:conv" },
    value: { nimbusConfirm: requestId, verdict, typed },
  });

  test("a card submit with the exact text dispatches the write", async () => {
    const h = await harness({ teams: true });
    await h.boot.service.start();
    const { requestId, confirmText } = await teamsCard(h);
    expect(confirmText.length).toBeGreaterThan(0);
    await h.boot.teamsSurface?.onActivity(
      submit("29:alice", requestId, "approve", confirmText, "s1"),
    );
    await until(() => h.dispatched.length === 1);
    expect(h.dispatched[0]?.type).toBe("github.pr.merge");
    expect(
      JSON.parse(h.audits.find((a) => a.actionType === "github.pr.merge")?.actionJson ?? "{}")
        .confirm,
    ).toBe("matched");
    await h.boot.service.stop();
  });

  test("wrong text is denied and audited as mismatched", async () => {
    const h = await harness({ teams: true });
    await h.boot.service.start();
    const { requestId } = await teamsCard(h);
    await h.boot.teamsSurface?.onActivity(submit("29:alice", requestId, "approve", "nope", "s1"));
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(JSON.parse(h.audits[0]?.actionJson ?? "{}").confirm).toBe("mismatched");
    expect(h.dispatched).toEqual([]);
    await h.boot.service.stop();
  });

  test("a non-owner submit and an unmapped submit spend nothing; the owner's correct submit still dispatches; a redelivery is a no-op", async () => {
    const h = await harness({ teams: true });
    await h.boot.service.start();
    const { requestId, confirmText } = await teamsCard(h);
    await h.boot.teamsSurface?.onActivity(
      submit("29:bob", requestId, "approve", confirmText, "s1"),
    );
    await h.boot.teamsSurface?.onActivity(submit("29:eve", requestId, "reject", "", "s2"));
    await new Promise((r) => setTimeout(r, 40));
    expect(h.audits.filter((a) => a.actionType === "github.pr.merge")).toEqual([]);
    await h.boot.teamsSurface?.onActivity(
      submit("29:alice", requestId, "approve", confirmText, "s3"),
    );
    await h.boot.teamsSurface?.onActivity(
      submit("29:alice", requestId, "approve", confirmText, "s3"),
    );
    await until(() => h.dispatched.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(h.dispatched).toHaveLength(1);
    await h.boot.service.stop();
  });

  test("the owner's Reject submit rejects", async () => {
    const h = await harness({ teams: true });
    await h.boot.service.start();
    const { requestId } = await teamsCard(h);
    await h.boot.teamsSurface?.onActivity(submit("29:alice", requestId, "reject", "", "s1"));
    await until(() => h.audits.some((a) => a.actionType === "github.pr.merge"));
    expect(h.audits[0]?.hitlStatus).toBe("rejected");
    expect(h.dispatched).toEqual([]);
    await h.boot.service.stop();
  });

  test("a text approve in the Teams channel does not approve the card", async () => {
    const h = await harness({ teams: true });
    await h.boot.service.start();
    await teamsCard(h);
    await h.boot.teamsSurface?.onActivity({
      type: "message",
      id: "t1",
      from: { id: "29:alice" },
      conversation: { id: "19:conv" },
      text: "approve",
    });
    await until(() => h.posts.some((p) => p.text === CHATOPS_CONFIRM_USE_FORM_REPLY));
    expect(h.dispatched).toEqual([]);
    await h.boot.service.stop();
  });
});

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { TribalKbConfig } from "../connectors/connector-writes/model-write-refusals.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import { buildOwnerPushExecutor } from "../engine/run-ask.ts";
import type { PlannedAction } from "../engine/types.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import { IncidentError } from "../incident/assemble.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { type PushTarget, pushPostmortem } from "./postmortem-push.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const NOTION_PARENT = "0123456789abcdef0123456789abcdef";
const NEW_PAGE = "fedcba98-7654-3210-fedc-ba9876543210";
const DRAFT =
  "# Post-mortem: Checkout latency\n\n## Summary\n\n- Source: pagerduty\n- Status: closed\n";

const inputOf = (a: PlannedAction | undefined): Record<string, unknown> =>
  (a?.payload?.["input"] ?? {}) as Record<string, unknown>;

type Reply = (a: PlannedAction) => unknown;
const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

type Rig = {
  readonly db: Database;
  readonly recordId: string;
  readonly prompts: string[];
  readonly dispatched: PlannedAction[];
  readonly audits: { actionType: string; hitlStatus: string; actionJson: string }[];
  readonly egress: EgressEntry[];
  push(target: PushTarget, md?: string, title?: string): ReturnType<typeof pushPostmortem>;
};

async function rig(
  o: {
    readonly answers?: readonly boolean[];
    readonly reply?: Reply;
    readonly kb?: TribalKbConfig;
  } = {},
): Promise<Rig> {
  const { db, recordId } = await seedPostmortemRecord();
  dbs.push(db);
  const prompts: string[] = [];
  const dispatched: PlannedAction[] = [];
  const audits: Rig["audits"] = [];
  const egress: EgressEntry[] = [];
  let n = 0;
  const coordinator: ConsentCoordinator = {
    requestConsent: async (_c, p) => {
      prompts.push(p.prompt);
      const approved = (o.answers ?? [true, true])[n++] ?? false;
      return { approved, answerSource: "human" };
    },
    requestConfirmedConsent: async () => {
      throw new Error("a page create is not a typed-confirm write");
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
        if (o.reply !== undefined) return o.reply(a);
        return a.type === "notion.page.create" ? text({ id: NEW_PAGE }) : text({ id: "12345" });
      },
    },
    egressSink: { append: (e) => egress.push(e) },
    policyHitl: NO_POLICY_OVERLAY,
  });
  return {
    db,
    recordId,
    prompts,
    dispatched,
    audits,
    egress,
    push: (target, md = DRAFT, title) =>
      pushPostmortem(
        { db, executor, refusal: { chatops: undefined, kb: o.kb } },
        recordId,
        target,
        md,
        title,
      ),
  };
}

const CONF: PushTarget = { kind: "confluence", spaceKey: "ENG", parentPageId: "777" };
const NOTION: PushTarget = { kind: "notion", parentPageId: NOTION_PARENT };

describe("the Confluence push", () => {
  test("an approved push dispatches ONE confluence.page.create as the owner's own linked action", async () => {
    const r = await rig();
    const out = await r.push(CONF);
    expect(out).toEqual({ outcome: "pushed", pageId: "12345" });
    expect(r.dispatched).toHaveLength(1);
    const a = r.dispatched[0] as PlannedAction;
    expect(a.type).toBe("confluence.page.create");
    expect(a.origin).toBeUndefined();
    expect(a.proposer).toBeUndefined();
    expect(a.provenance).toBeUndefined();
    expect(a.incident).toEqual({ id: r.recordId, version: 1 });
    const input = inputOf(a);
    expect(input["spaceKey"]).toBe("ENG");
    expect(input["parentPageId"]).toBe("777");
    expect(input["title"]).toBe("Post-mortem: Checkout latency");
    expect(String(input["storageHtml"])).toContain("<h2>Summary</h2>");
    expect(String(input["storageHtml"])).not.toContain("Post-mortem: Checkout");
  });

  test("the owner sees the typed preview, not a JSON dump, and the audit row carries the link first", async () => {
    const r = await rig();
    await r.push(CONF);
    expect(r.prompts).toHaveLength(1);
    expect(r.prompts[0]).toContain("Create a Confluence page in space ENG");
    expect(r.prompts[0]).not.toContain("Details:");
    const row = r.audits.find((x) => x.actionType === "confluence.page.create");
    expect(row?.hitlStatus).toBe("approved");
    expect(row?.actionJson.startsWith(`{"incident":{"id":"${r.recordId}","version":1}`)).toBe(true);
    expect(row?.actionJson).toContain('"answerSource":"human"');
    expect(r.egress).toHaveLength(1);
  });

  test("a denial writes nothing: no dispatch, an audit row that says rejected", async () => {
    const r = await rig({ answers: [false] });
    const out = await r.push(CONF);
    expect(out.outcome).toBe("denied");
    expect(r.dispatched).toEqual([]);
    expect(r.audits.find((x) => x.actionType === "confluence.page.create")?.hitlStatus).toBe(
      "rejected",
    );
  });

  test("a page with no parent sends none; an unreadable reply still reports the push", async () => {
    const r = await rig({ reply: () => text({ no: "id" }) });
    const out = await r.push({ kind: "confluence", spaceKey: "ENG" });
    expect(out).toEqual({ outcome: "pushed", pageId: null });
    expect(Object.hasOwn(inputOf(r.dispatched[0]), "parentPageId")).toBe(false);
    const bad = await rig({ reply: () => "not an mcp result" });
    expect(await bad.push(CONF)).toEqual({ outcome: "pushed", pageId: null });
  });

  test("a dispatch failure is reported as not done, with control characters removed and the text cut", async () => {
    const r = await rig({
      reply: () => {
        throw new Error(`boom\u001b[31m\n${"x".repeat(500)}`);
      },
    });
    const out = await r.push(CONF);
    expect(out.outcome).toBe("denied");
    const reason = (out as { reason: string }).reason;
    expect(reason.startsWith("boom [31m xxx")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(301);
    expect(reason).not.toContain("\u001b");
  });

  test("a dispatch that throws a non-Error value is reported by its text", async () => {
    const r = await rig({
      reply: () => {
        throw "plain string failure";
      },
    });
    expect(await r.push(CONF)).toEqual({ outcome: "denied", reason: "plain string failure" });
  });

  test("an unexpected error inside the push is not swallowed as a refusal", async () => {
    const r = await rig();
    const boom = {
      chatops: undefined,
      get kb(): never {
        throw new Error("config exploded");
      },
    };
    await expect(
      pushPostmortem(
        {
          db: r.db,
          executor: { execute: async () => ({ status: "ok", result: 1 }) },
          refusal: boom,
        },
        r.recordId,
        CONF,
        DRAFT,
        undefined,
      ),
    ).rejects.toThrow("config exploded");
  });

  test("the tribal KB parent is refused before any prompt", async () => {
    const r = await rig({ kb: { confluence: { spaceKey: "ENG", parentPageId: "777" } } });
    const out = await r.push(CONF);
    expect(out.outcome).toBe("refused");
    expect((out as { code: string }).code).toBe("ERR_POSTMORTEM_PUSH_REFUSED");
    expect(r.prompts).toEqual([]);
    expect(r.dispatched).toEqual([]);
  });

  test("an unreadable KB config refuses every page write", async () => {
    const r = await rig({ kb: { unreadable: true } });
    expect((await r.push(CONF)).outcome).toBe("refused");
    expect(r.prompts).toEqual([]);
  });

  test("a Markdown image refuses before any prompt; raw HTML arrives escaped", async () => {
    const r = await rig();
    const img = await r.push(CONF, `${DRAFT}\n![x](http://evil.example/p.png)\n`);
    expect(img).toMatchObject({ outcome: "refused", code: "ERR_POSTMORTEM_PUSH_IMAGE" });
    expect(r.prompts).toEqual([]);
    // The structural scan reads entities, so even an escaped <img src=...> is refused (fail closed).
    const raw = await r.push(CONF, `${DRAFT}\n<img src="http://evil.example/p.png">\n`);
    expect(raw).toMatchObject({ outcome: "refused", code: "ERR_POSTMORTEM_PUSH_REFUSED" });
    expect(r.prompts).toEqual([]);
    const html = await r.push(CONF, `${DRAFT}\n<iframe> <script>x</script>\n`);
    expect(html.outcome).toBe("pushed");
    const sent = String(inputOf(r.dispatched[0])["storageHtml"]);
    expect(sent).not.toMatch(/<(?:img|iframe|script)/);
  });

  test("a file with no title, or a bad title, refuses; --title fills in", async () => {
    const r = await rig();
    expect(await r.push(CONF, "## Summary\nbody\n")).toMatchObject({
      outcome: "refused",
      code: "ERR_POSTMORTEM_PUSH_TITLE",
    });
    expect(await r.push(CONF, "# \u202e\n")).toMatchObject({ outcome: "refused" });
    expect(await r.push(CONF, "# T\n")).toMatchObject({
      outcome: "refused",
      code: "ERR_POSTMORTEM_PUSH_EMPTY",
    });
    expect((await r.push(CONF, "## Summary\nbody\n", "Given")).outcome).toBe("pushed");
    expect(r.dispatched).toHaveLength(1);
  });

  test("an unknown record mints no link and dispatches nothing", async () => {
    const r = await rig();
    let caught: unknown;
    try {
      await pushPostmortem(
        {
          db: r.db,
          executor: { execute: async () => ({ status: "ok", result: 1 }) },
          refusal: { chatops: undefined, kb: undefined },
        },
        "inc_0000000000000000",
        CONF,
        DRAFT,
        undefined,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IncidentError);
    expect(r.dispatched).toEqual([]);
  });
});

describe("the Notion push (two existing rows, two approvals)", () => {
  test("create, then an append on the page id the create returned, both linked and both asked", async () => {
    const r = await rig();
    const out = await r.push(NOTION);
    expect(out).toEqual({ outcome: "pushed", pageId: NEW_PAGE });
    expect(r.dispatched.map((a) => a.type)).toEqual(["notion.page.create", "notion.block.append"]);
    const [create, append] = r.dispatched as [PlannedAction, PlannedAction];
    expect(inputOf(create)["parentPageId"]).toBe(NOTION_PARENT);
    const appendInput = inputOf(append);
    expect(appendInput["parentBlockId"]).toBe(NEW_PAGE);
    expect(JSON.parse(String(appendInput["childrenJson"])).length).toBeGreaterThan(0);
    expect(create.incident).toEqual({ id: r.recordId, version: 1 });
    expect(append.incident).toEqual({ id: r.recordId, version: 1 });
    expect(r.prompts).toHaveLength(2);
    expect(r.prompts[0]).toContain(`Create a Notion page under page ${NOTION_PARENT}`);
    expect(r.prompts[1]).toContain(`Append blocks to the end of Notion page or block ${NEW_PAGE}`);
    for (const a of r.audits.filter((x) => x.hitlStatus === "approved")) {
      expect(a.actionJson.startsWith(`{"incident":{"id":"${r.recordId}"`)).toBe(true);
    }
  });

  test("a denied create never attempts the append (no second prompt, one dispatch at most)", async () => {
    const r = await rig({ answers: [false, true] });
    const out = await r.push(NOTION);
    expect(out.outcome).toBe("denied");
    expect(r.prompts).toHaveLength(1);
    expect(r.dispatched).toEqual([]);
  });

  test("an approved create and a denied append is PARTIAL: the page id is reported", async () => {
    const r = await rig({ answers: [true, false] });
    const out = await r.push(NOTION);
    expect(out).toMatchObject({
      outcome: "partial",
      code: "ERR_POSTMORTEM_PUSH_PARTIAL",
      pageId: NEW_PAGE,
    });
    expect(r.dispatched.map((a) => a.type)).toEqual(["notion.page.create"]);
  });

  test("a create whose reply holds no readable id is 'unavailable' and does not ask for the append", async () => {
    const r = await rig({ reply: () => text({ id: "not-a-uuid" }) });
    const out = await r.push(NOTION);
    expect(out).toMatchObject({ outcome: "unavailable", code: "ERR_POSTMORTEM_PUSH_PARTIAL" });
    expect(r.prompts).toHaveLength(1);
    const bad = await rig({ reply: () => 42 });
    expect((await bad.push(NOTION)).outcome).toBe("unavailable");
  });

  test("a body too large for one append refuses before the page is created", async () => {
    const r = await rig();
    const lines = Array.from({ length: 150 }, (_, i) => `- item ${String(i)}`).join("\n");
    const out = await r.push(NOTION, `# T\n${lines}\n`);
    expect(out).toMatchObject({ outcome: "refused", code: "ERR_POSTMORTEM_PUSH_TOO_LARGE" });
    expect(r.prompts).toEqual([]);
    expect(r.dispatched).toEqual([]);
  });

  test("the KB database as the parent is refused before any prompt", async () => {
    const r = await rig({ kb: { notion: { databaseId: NOTION_PARENT } } });
    expect((await r.push(NOTION)).outcome).toBe("refused");
    expect(r.prompts).toEqual([]);
  });

  test("a failure of the append after an approval is partial too", async () => {
    const r = await rig({
      reply: (a) => {
        if (a.type === "notion.block.append") throw new Error("429");
        return text({ id: NEW_PAGE });
      },
    });
    expect(await r.push(NOTION)).toMatchObject({
      outcome: "partial",
      pageId: NEW_PAGE,
      reason: "429",
    });
  });

  test("the late KB check on the real page id is the same refusal function (a page id equal to the KB database)", async () => {
    // The create reply names the KB database itself: the append must be refused after the page exists.
    const kbId = "aaaaaaaabbbbccccddddeeeeeeeeeeee";
    const r = await rig({
      kb: { notion: { databaseId: kbId } },
      reply: () => text({ id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }),
    });
    const out = await r.push(NOTION);
    expect(out).toMatchObject({ outcome: "partial", code: "ERR_POSTMORTEM_PUSH_PARTIAL" });
    expect(r.dispatched.map((a) => a.type)).toEqual(["notion.page.create"]);
    expect(r.prompts).toHaveLength(1);
  });
});

// Phase 10 SA2: `gmail_thread_archive` is listed by the Gmail connector only when the stored token
// holds `gmail.modify` (or the full-mailbox scope). `connector writes enable` and `status` read the
// same scopes and say so, instead of offering a write that cannot run.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../engine/executor.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMockVault } from "../vault/mock.ts";
import { dispatchConnectorRpc } from "./connector-rpc.ts";

const MODIFY = "https://www.googleapis.com/auth/gmail.modify";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const FULL = "https://mail.google.com/";

let db: Database;
let localIndex: LocalIndex;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

function executor(prompts: string[]): ToolExecutor {
  return new ToolExecutor(
    {
      requestApproval: async (prompt: string) => {
        prompts.push(prompt);
        return { approved: true, answerSource: "human" as const };
      },
    },
    localIndex,
    { dispatch: async () => ({}) },
    undefined,
    NULL_EGRESS_SINK,
    NO_POLICY_OVERLAY,
  );
}

async function vaultHolding(
  scopes: string[] | undefined,
): Promise<ReturnType<typeof createMockVault>> {
  const vault = createMockVault();
  if (scopes !== undefined) {
    await vault.set(
      "google.oauth",
      JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 1, scopes }),
    );
  }
  return vault;
}

async function call(
  method: string,
  params: unknown,
  vault: ReturnType<typeof createMockVault>,
  exec?: ToolExecutor,
): Promise<unknown> {
  const r = await dispatchConnectorRpc({
    method,
    params,
    vault,
    localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    getEnforcedPolicy: (() => ({ capabilitiesDisabled: new Set<string>() })) as never,
    ...(exec === undefined ? {} : { toolExecutor: exec }),
  });
  if (r.kind !== "hit") throw new Error("miss");
  return r.value;
}

type StatusService = {
  service: string;
  offerable: number;
  awaitingApproval: number;
  notOffered?: { toolId: string; reason: string }[];
};

async function gmailStatus(vault: ReturnType<typeof createMockVault>): Promise<StatusService> {
  const out = (await call("connector.writesStatus", {}, vault)) as { services: StatusService[] };
  const g = out.services.find((s) => s.service === "gmail");
  if (g === undefined) throw new Error("no gmail service");
  return g;
}

describe("the Gmail archive row and the token's scopes (status)", () => {
  test("a token without gmail.modify: the archive row is not offered, with the re-authorise reason", async () => {
    const g = await gmailStatus(await vaultHolding([READONLY]));
    expect(g.notOffered).toEqual([
      { toolId: "gmail_thread_archive", reason: "re-authorise Gmail to grant gmail.modify" },
    ]);
    // The draft stays offerable; the archive is in neither count.
    expect(g.awaitingApproval).toBe(1);
  });

  test("a token with gmail.modify, or the full-mailbox scope: the archive row is offerable", async () => {
    for (const scopes of [[READONLY, MODIFY], [FULL]]) {
      const g = await gmailStatus(await vaultHolding(scopes));
      expect(g.notOffered).toBeUndefined();
      expect(g.awaitingApproval).toBe(2);
    }
  });

  test("no Google credential at all, or one that records no scopes: not offered", async () => {
    for (const scopes of [undefined, []] as const) {
      const g = await gmailStatus(await vaultHolding(scopes as string[] | undefined));
      expect(g.notOffered?.[0]?.toolId).toBe("gmail_thread_archive");
      expect(g.awaitingApproval).toBe(1);
    }
  });

  test("a service other than Gmail makes no claim", async () => {
    const vault = await vaultHolding([READONLY]);
    const out = (await call("connector.writesStatus", {}, vault)) as { services: StatusService[] };
    for (const s of out.services.filter((x) => x.service !== "gmail")) {
      expect(s.notOffered).toBeUndefined();
    }
  });

  test("a vault that throws makes no claim (the row keeps its ordinary state)", async () => {
    const vault = createMockVault();
    vault.get = async () => {
      throw new Error("locked");
    };
    const g = await gmailStatus(vault);
    expect(g.notOffered).toBeUndefined();
    expect(g.awaitingApproval).toBe(2);
  });
});

describe("the Gmail archive row in the enable prompt", () => {
  test("without the scope the line says what to do, and the row is not approved by name", async () => {
    const prompts: string[] = [];
    await call(
      "connector.writesEnable",
      { service: "gmail", wave: 2 },
      await vaultHolding([READONLY]),
      executor(prompts),
    );
    const p = prompts[0] ?? "";
    expect(p).toContain(
      "gmail_thread_archive  gmail.thread.archive  wave 2  (not offered yet: re-authorise Gmail to grant gmail.modify)",
    );
    expect(p).toContain(
      "gmail_draft_create  gmail.draft.create  wave 2  (new: offered after you approve)",
    );
  });

  test("with the scope it is offered after approval like any wave 2 write", async () => {
    const prompts: string[] = [];
    await call(
      "connector.writesEnable",
      { service: "gmail", wave: 2 },
      await vaultHolding([MODIFY]),
      executor(prompts),
    );
    expect(prompts[0]).toContain(
      "gmail_thread_archive  gmail.thread.archive  wave 2  (new: offered after you approve)",
    );
  });
});

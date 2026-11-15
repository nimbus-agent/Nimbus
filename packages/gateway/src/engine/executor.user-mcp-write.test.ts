// I15 at the prompt (Phase 28 AD5b-2): every door that asks about a call to a user MCP server shows
// what the server's code may write, a call it cannot show that for is refused before any prompt, and
// an OUTSIDE AGENT's call to a write-granted server is approved only by typing the server id.
import { describe, expect, test } from "bun:test";

import {
  NO_POLICY_OVERLAY,
  ToolExecutor,
  type ToolExecutorExtras,
  USER_MCP_WRITE_UNKNOWN_REASON,
} from "./executor.ts";
import type {
  ConfirmedApprovalRequest,
  ConsentChannel,
  PlannedAction,
  UserMcpCallFacts,
} from "./types.ts";
import { userMcpCallLines } from "./user-mcp-call-block.ts";
import { USER_MCP_WRITE_HEADER, USER_MCP_WRITE_WARNING_LINES } from "./user-mcp-write-lines.ts";

const OUT = "/home/me/work/out";

interface Harness {
  readonly exec: ToolExecutor;
  readonly plain: string[];
  readonly confirmed: ConfirmedApprovalRequest[];
  readonly dispatched: PlannedAction[];
  readonly audits: string[];
}

function harness(
  extras: ToolExecutorExtras | "none",
  opts: { typed?: string; confirm?: "absent"; approve?: boolean } = {},
): Harness {
  const plain: string[] = [];
  const confirmed: ConfirmedApprovalRequest[] = [];
  const dispatched: PlannedAction[] = [];
  const audits: string[] = [];
  const consent: ConsentChannel = {
    requestApproval: async (prompt) => {
      plain.push(prompt);
      return { approved: opts.approve ?? true, answerSource: "human" as const };
    },
    ...(opts.confirm === "absent"
      ? {}
      : {
          requestConfirmedApproval: async (req: ConfirmedApprovalRequest) => {
            confirmed.push(req);
            return {
              approved: opts.approve ?? true,
              typed: opts.typed ?? req.confirmText,
              answerSource: "human" as const,
            };
          },
        }),
  };
  const exec = new ToolExecutor(
    consent,
    { recordAudit: (e) => audits.push(e.actionJson) },
    {
      dispatch: async (a) => {
        dispatched.push(a);
        return { ok: true };
      },
    },
    undefined,
    { append: () => undefined },
    NO_POLICY_OVERLAY,
    undefined,
    extras === "none" ? {} : extras,
  );
  return { exec, plain, confirmed, dispatched, audits };
}

const OWNER_CALL: PlannedAction = {
  type: "mcp_notes.append",
  payload: { mcpToolId: "mcp_notes_append", input: { text: "hello" } },
};
const MODEL_CALL: PlannedAction = { ...OWNER_CALL, origin: "model" };

const FACTS: UserMcpCallFacts = {
  serviceId: "mcp_notes",
  tool: "append",
  registeredAt: Date.UTC(2026, 10, 1),
  readPaths: ["/data/notes"],
  netHosts: [],
  writePaths: [OUT],
  approval: null,
};
const AGENT_CALL: PlannedAction = {
  ...OWNER_CALL,
  origin: "agent",
  proposer: {
    door: "agent",
    captureId: "cap_0123456789abcdef0123456789abcdef",
    label: "agent",
    labelSource: "declared",
    summary: "add a note",
    createdAt: 0,
    expiresAt: 60_000,
  },
  userMcpCall: FACTS,
};

describe("the owner's and the model's call to a user MCP server", () => {
  for (const [who, action] of [
    ["the owner", OWNER_CALL],
    ["the model", MODEL_CALL],
  ] as const) {
    test(`${who}: a server with a write directory shows the block before the input, and takes a plain answer`, async () => {
      const h = harness({ userMcpWriteGrants: () => [OUT] });
      const res = await h.exec.execute(action);
      expect(res.status).toBe("ok");
      expect(h.confirmed).toEqual([]);
      const lines = (h.plain[0] ?? "").split("\n");
      const header = lines.indexOf(USER_MCP_WRITE_HEADER);
      expect(header).toBeGreaterThan(0);
      expect(lines[header + 1]).toBe(`  write: ${OUT}`);
      for (const w of USER_MCP_WRITE_WARNING_LINES) expect(lines).toContain(w);
      expect(lines.findIndex((l) => l.startsWith("Details: "))).toBeGreaterThan(header);
      expect(h.dispatched).toHaveLength(1);
    });

    test(`${who}: a server with NO write directory gets exactly the prompt it always had`, async () => {
      const withReader = harness({ userMcpWriteGrants: () => [] });
      await withReader.exec.execute(action);
      expect(withReader.plain[0]).not.toContain("WRITE ACCESS");
      expect(withReader.plain[0]).toContain("Details: ");
      expect(withReader.plain[0]?.split("\n").filter((l) => l.startsWith("  write:"))).toEqual([]);
    });

    test(`${who}: an executor with no reader refuses before any prompt, and nothing is dispatched`, async () => {
      const h = harness("none");
      const res = await h.exec.execute(action);
      expect(res).toMatchObject({ status: "rejected", reason: USER_MCP_WRITE_UNKNOWN_REASON });
      expect(h.plain).toEqual([]);
      expect(h.confirmed).toEqual([]);
      expect(h.dispatched).toEqual([]);
      expect(h.audits.join("\n")).toContain(USER_MCP_WRITE_UNKNOWN_REASON);
    });

    test(`${who}: a reader that cannot tell, or throws, refuses the same way`, async () => {
      for (const reader of [
        () => undefined,
        () => {
          throw new Error("db closed");
        },
      ]) {
        const h = harness({ userMcpWriteGrants: reader });
        const res = await h.exec.execute(action);
        expect(res).toMatchObject({ status: "rejected", reason: USER_MCP_WRITE_UNKNOWN_REASON });
        expect(h.plain).toEqual([]);
        expect(h.dispatched).toEqual([]);
      }
    });
  }

  test("the reader is asked for the server the TYPE names, never one a payload names", async () => {
    const asked: string[] = [];
    const h = harness({
      userMcpWriteGrants: (id) => {
        asked.push(id);
        return [];
      },
    });
    await h.exec.execute({
      type: "mcp_notes.append",
      payload: { mcpToolId: "mcp_other_append", serviceId: "mcp_other", input: {} },
    });
    expect(new Set(asked)).toEqual(new Set(["mcp_notes"]));
  });

  test("an action that is not a user MCP call never consults the reader", async () => {
    let asked = 0;
    const h = harness({
      userMcpWriteGrants: () => {
        asked += 1;
        return undefined;
      },
    });
    const res = await h.exec.execute({ type: "search.run", payload: {} });
    expect(res.status).toBe("ok");
    expect(asked).toBe(0);
  });
});

describe("an outside agent's call to a user MCP server (owner ruling OR-AD-32)", () => {
  test("a server WITH a write directory: approved only by typing the server id; the prompt shows the block", async () => {
    const h = harness("none");
    const res = await h.exec.execute(AGENT_CALL);
    expect(res.status).toBe("ok");
    expect(h.plain).toEqual([]);
    expect(h.confirmed).toHaveLength(1);
    expect(h.confirmed[0]?.confirmText).toBe("mcp_notes");
    const prompt = h.confirmed[0]?.prompt ?? "";
    expect(prompt).toContain(USER_MCP_WRITE_HEADER);
    expect(prompt).toContain(`  write: ${OUT}`);
    expect(h.dispatched).toHaveLength(1);
  });

  test("the wrong text, or a different letter case, is a denial and nothing is dispatched", async () => {
    for (const typed of ["mcp_note", "MCP_NOTES", "mcp_notes ", ""]) {
      const h = harness("none", { typed });
      const res = await h.exec.execute(AGENT_CALL);
      expect(res.status, typed).toBe("rejected");
      expect(h.dispatched).toEqual([]);
    }
  });

  test("a channel that cannot collect typed text denies it (ChatOps, a delegate): never a plain prompt", async () => {
    const h = harness("none", { confirm: "absent" });
    const res = await h.exec.execute(AGENT_CALL);
    expect(res.status).toBe("rejected");
    expect(h.plain).toEqual([]);
    expect(h.dispatched).toEqual([]);
  });

  test("a server with NO write directory keeps the plain answer (OR-AD-24)", async () => {
    const h = harness("none");
    const res = await h.exec.execute({
      ...AGENT_CALL,
      userMcpCall: { ...FACTS, writePaths: [] },
    });
    expect(res.status).toBe("ok");
    expect(h.confirmed).toEqual([]);
    expect(h.plain).toHaveLength(1);
    expect(h.plain[0]).toContain("  write: none beyond its own sandbox directory");
  });

  test("the reader is never what an agent's call is judged by: its own facts are", async () => {
    // A reader saying "no write directory" cannot turn the typed confirmation off.
    const h = harness({ userMcpWriteGrants: () => [] });
    await h.exec.execute(AGENT_CALL);
    expect(h.confirmed).toHaveLength(1);
    expect(h.plain).toEqual([]);
  });
});

describe("the agent door's call block", () => {
  test("with a write directory: the write block replaces the none line, with the OS line for the platform", () => {
    const linux = userMcpCallLines(FACTS, "linux");
    expect(linux).toContain(USER_MCP_WRITE_HEADER);
    expect(linux).toContain(`  write: ${OUT}`);
    expect(linux).toContain("It can also delete and rename there.");
    expect(linux).not.toContain("  write: none beyond its own sandbox directory");
    for (const w of USER_MCP_WRITE_WARNING_LINES) expect(linux).toContain(w);
    expect(userMcpCallLines(FACTS, "win32")).toContain(
      "On Windows it cannot delete or rename there.",
    );
  });

  test("without one: the block is what it was before AD5b", () => {
    const lines = userMcpCallLines({ ...FACTS, writePaths: [] }, "linux");
    expect(lines).toContain("  write: none beyond its own sandbox directory");
    expect(lines.join("\n")).not.toContain("WRITE ACCESS");
  });
});

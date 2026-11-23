import { describe, expect, test } from "bun:test";

import type { IncidentIpc } from "./incident.ts";
import { parseIncidentArgs } from "./incident-format.ts";
import { parseRemediationArgs, runRemediation, TTY_REFUSAL } from "./incident-remediate.ts";

const ACT = "act_0123456789abcdef";
const TTY = { stdin: true, stdout: true };

function harness(reply: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return reply;
    },
  } as unknown as IncidentIpc;
  return {
    out,
    err,
    calls,
    ipc,
    sink: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) },
  };
}

describe("nimbus incident undo with no id", () => {
  test("parses with no id, still rejects a malformed or extra one", () => {
    expect(parseRemediationArgs("undo", [])).toEqual({ verb: "undo" });
    expect(parseIncidentArgs(["undo"])).toMatchObject({ verb: "undo" });
    for (const bad of [["act_x"], [ACT, "x"], ["--act"], ["--yes"]]) {
      expect(parseRemediationArgs("undo", bad)).toBeUndefined();
    }
  });

  test("sends no actionId, so the gateway picks the latest, and reports the action it undid", async () => {
    const h = harness({ actionId: ACT, status: "undone", nonHuman: false });
    const code = await runRemediation(h.ipc, { verb: "undo" }, h.sink, TTY);
    expect(code).toBe(0);
    expect(h.calls).toEqual([{ method: "incident.undo", params: {} }]);
    expect(h.out.join("")).toContain(`Undone. Action ${ACT} was reversed.`);
  });

  test("a named id is still sent as before", async () => {
    const h = harness({ actionId: ACT, status: "undone", nonHuman: false });
    await runRemediation(h.ipc, { verb: "undo", actionId: ACT }, h.sink, TTY);
    expect(h.calls).toEqual([{ method: "incident.undo", params: { actionId: ACT } }]);
  });

  test("needs a terminal: nothing is sent without one", async () => {
    const h = harness({});
    const code = await runRemediation(h.ipc, { verb: "undo" }, h.sink, {
      stdin: false,
      stdout: false,
    });
    expect(code).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.err.join("")).toContain(TTY_REFUSAL);
  });
});

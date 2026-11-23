import { describe, expect, test } from "bun:test";

import { type IncidentIpc, runIncidentWith } from "./incident.ts";
import { INCIDENT_USAGE, parseIncidentArgs } from "./incident-format.ts";

const REC = "inc_0123456789abcdef";

function harness(replies: Record<string, unknown>) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const ipc = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return method === "session.declareKind" ? {} : replies[method];
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

describe("nimbus incident investigate --synthesize", () => {
  test("parses the flag for investigate only, once, with any other word an error", () => {
    expect(parseIncidentArgs(["investigate", REC, "--synthesize"])).toEqual({
      verb: "investigate",
      json: false,
      id: REC,
      synthesize: true,
    });
    expect(parseIncidentArgs(["investigate", "--json", "--synthesize", REC])).toMatchObject({
      json: true,
      synthesize: true,
    });
    expect(parseIncidentArgs(["investigate", REC])).toEqual({
      verb: "investigate",
      json: false,
      id: REC,
    });
    expect(parseIncidentArgs(["investigate", REC, "--synthesize", "--synthesize"])).toBeUndefined();
    expect(parseIncidentArgs(["show", REC, "--synthesize"])).toBeUndefined();
    expect(INCIDENT_USAGE).toContain("investigate <id> [--synthesize] [--json]");
  });

  test("without the flag nothing but the plain investigation is called", async () => {
    const h = harness({
      "incident.investigate": { investigation: {}, markdown: "# Investigation: x\n" },
    });
    await runIncidentWith(h.ipc, { verb: "investigate", json: false, id: REC }, h.sink, 0);
    expect(h.calls.map((c) => c.method)).toEqual(["session.declareKind", "incident.investigate"]);
  });

  test("with the flag the synthesize method is called and the note says who rewrote it", async () => {
    const h = harness({
      "incident.investigateSynthesize": {
        markdown: "# Investigation: x\n\n## Summary\n\nTHE-REWRITE\n",
        synthesis: { attempted: true, used: true, model: "m1", remote: false },
      },
    });
    const code = await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: false, id: REC, synthesize: true },
      h.sink,
      0,
    );
    expect(code).toBe(0);
    expect(h.calls.map((c) => c.method)).toEqual([
      "session.declareKind",
      "incident.investigateSynthesize",
    ]);
    expect(h.calls[1]?.params).toEqual({ id: REC });
    const text = h.out.join("");
    expect(text).toContain("THE-REWRITE");
    expect(text).toContain("Prose sections rewritten by m1");
  });

  test("no model, and a discarded rewrite, are each said plainly", async () => {
    const none = harness({
      "incident.investigateSynthesize": {
        markdown: "# Investigation: x\n",
        synthesis: { attempted: false, reason: "disabled" },
      },
    });
    await runIncidentWith(
      none.ipc,
      { verb: "investigate", json: false, id: REC, synthesize: true },
      none.sink,
      0,
    );
    expect(none.out.join("")).toContain("No model was used (disabled)");
    const dropped = harness({
      "incident.investigateSynthesize": {
        markdown: "# Investigation: x\n",
        synthesis: { attempted: true, used: false, reason: "contract_violation" },
      },
    });
    await runIncidentWith(
      dropped.ipc,
      { verb: "investigate", json: false, id: REC, synthesize: true },
      dropped.sink,
      0,
    );
    expect(dropped.out.join("")).toContain("rewrite was not used (contract_violation)");
  });

  test("--json prints the reply as is", async () => {
    const reply = {
      markdown: "m",
      synthesis: { attempted: false, reason: "disabled" },
    };
    const h = harness({ "incident.investigateSynthesize": reply });
    await runIncidentWith(
      h.ipc,
      { verb: "investigate", json: true, id: REC, synthesize: true },
      h.sink,
      0,
    );
    expect(JSON.parse(h.out.join(""))).toEqual(reply);
  });
});

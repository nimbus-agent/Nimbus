import { describe, expect, test } from "bun:test";
import {
  checkFreeBusyConfinement,
  type FileEntry,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { read } from "../../test/helpers/security-invariants.ts";

const F = "packages/gateway/src/federation/";
const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

describe("I17 (b): federated free/busy answering is intrinsic to its gate", () => {
  test("federation.freeBusy is answered only through answerFederatedFreeBusy, in the LAN server", async () => {
    const server = await read(`${F}federation-server.ts`);
    expect(server).toContain("answerFederatedFreeBusy(");
    expect(server).toContain('method === "federation.freeBusy"');
    const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
    expect(rpc).not.toContain("freeBusy");
  });

  test("the answering method is admitted over the LAN; the owner-only scheduling namespace is not", async () => {
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toContain('"scheduling"');
    expect(lan).not.toContain('"federation.freeBusy"');
  });

  test("the approval is a consent broker answered by a person, not a frozen-set HITL type", async () => {
    const broker = await read(`${F}schedule-consent-broker.ts`);
    expect(broker).toContain('from.answerSource === "human"');
    expect(broker).toContain('from.kind === "cli"');
    const executor = await read("packages/gateway/src/engine/executor.ts");
    expect(executor).not.toMatch(/federation\.(?:freebusy|schedule)/i);
  });

  test("the gate reads nothing before the owner approves", async () => {
    const gate = await read(`${F}free-busy-gate.ts`);
    expect(gate.indexOf("ctx.requestApproval(")).toBeGreaterThan(0);
    expect(gate.indexOf("ctx.requestApproval(")).toBeLessThan(gate.indexOf("readBusyBlocks("));
    expect(gate.indexOf("ctx.requestApproval(")).toBeLessThan(gate.indexOf("calendarReadiness("));
  });

  test("the reporter calls the D13(b) checker", async () => {
    const report = await read("scripts/structure-audit/invariants/report-4.ts");
    expect(report).toContain("checkFreeBusyConfinement(files)");
  });

  test("D13(b) is wired into the static auditor", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("free-busy-read-confined");
    expect(audit).toContain("free-busy-gate-confined");
    expect(audit).toContain("free-busy-forbidden-field");
    expect(audit).toContain(`${F}free-busy-gate.ts`);
  });
});

describe("D13(b) detects what it forbids", () => {
  test("a clean tree is clean", () => {
    expect(
      checkFreeBusyConfinement([
        file(`${F}free-busy-gate.ts`, `import { readBusyBlocks } from "./_lib/free-busy-read.ts";`),
        file(`${F}schedule-ask.ts`, `import { readBusyBlocks } from "./_lib/free-busy-read.ts";`),
        file(`${F}federation-server.ts`, "answerFederatedFreeBusy(ctx, q);"),
      ]),
    ).toEqual([]);
  });
  test("another module importing the reader is refused", () => {
    const v = checkFreeBusyConfinement([
      file(`${F}query-gate.ts`, `import { readBusyBlocks } from "./_lib/free-busy-read.ts";`),
    ]);
    expect(v.map((x) => x.rule)).toEqual(["free-busy-read-confined"]);
  });
  test("another module naming the gate function is refused", () => {
    const v = checkFreeBusyConfinement([
      file("packages/gateway/src/ipc/federation-rpc.ts", "answerFederatedFreeBusy(c, q);"),
    ]);
    expect(v.map((x) => x.rule)).toEqual(["free-busy-gate-confined"]);
  });
  test("a reader import split over two lines is refused", () => {
    const v = checkFreeBusyConfinement([
      file(
        `${F}query-gate.ts`,
        `import { readBusyBlocks } from
  "./_lib/free-busy-read.ts";`,
      ),
    ]);
    expect(v.map((x) => x.rule)).toEqual(["free-busy-read-confined"]);
  });
  test("an event id access in a shaping file is refused, a bare id is not", () => {
    const bad = (src: string) =>
      checkFreeBusyConfinement([file(`${F}free-busy-gate.ts`, src)]).map((x) => x.rule);
    expect(bad("const e = meta.id;")).toEqual(["free-busy-forbidden-field"]);
    expect(bad('const e = meta["id"];')).toEqual(["free-busy-forbidden-field"]);
    expect(bad("const { id } = meta;")).toEqual(["free-busy-forbidden-field"]);
    expect(bad("for (const id of CALENDAR_SERVICES) { q.get(id); }")).toEqual([]);
    expect(bad("const s = 'ORDER BY modified_at DESC, id LIMIT 1';")).toEqual([]);
  });
  test("an event field in a shaping file is refused in code and in SQL, but not in a comment", () => {
    const v = checkFreeBusyConfinement([
      file(
        `${F}_lib/free-busy-read.ts`,
        "// the title is never read\nconst sql = `SELECT title FROM item`;",
      ),
      file(`${F}free-busy-gate.ts`, "const x = meta.attendees;"),
    ]);
    expect(v.map((x) => `${x.file.split("/").pop()}:${x.rule}`)).toEqual([
      "free-busy-read.ts:free-busy-forbidden-field",
      "free-busy-gate.ts:free-busy-forbidden-field",
    ]);
  });
});

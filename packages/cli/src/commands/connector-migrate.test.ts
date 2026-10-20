import { describe, expect, test } from "bun:test";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import {
  formatMigrationRows,
  type MigrateIo,
  type MigrationRowCli,
  runConnectorMigrate,
} from "./connector-migrate.ts";

const ROW: MigrationRowCli = {
  id: "m-1",
  legacyServiceId: "fixturewise",
  extensionId: "com.example.fixturewise",
  version: "1.0.0",
  state: "awaiting_approval",
  error: null,
  updatedAt: 1,
};

function harness(
  responses: ReadonlyArray<unknown>,
  tty: { stdin: boolean; stdout: boolean } = { stdin: true, stdout: true },
  answer: boolean | undefined = undefined,
) {
  const mock = createMockIpcClient(responses);
  const lines: string[] = [];
  const opened: Array<number | undefined> = [];
  let disconnected = 0;
  const client = {
    ...(mock.client as unknown as Record<string, unknown>),
    disconnect: async () => {
      disconnected += 1;
    },
  } as unknown as IPCClient;
  const io: MigrateIo = {
    stdinIsTty: tty.stdin,
    stdoutIsTty: tty.stdout,
    open: async (t) => {
      opened.push(t);
      return client;
    },
    ...(answer === undefined ? {} : { confirm: async () => answer }),
    log: (l) => lines.push(l),
  };
  return { io, lines, calls: mock.calls, emit: mock.emit, opened, disconnects: () => disconnected };
}

describe("nimbus connector migrate", () => {
  test("list prints each row with its next step", async () => {
    const h = harness([{ migrations: [ROW] }]);
    await runConnectorMigrate(["list"], h.io);
    expect(h.calls).toEqual([{ method: "migration.list", params: {} }]);
    expect(h.lines.join("\n")).toContain("m-1  fixturewise -> com.example.fixturewise 1.0.0");
    expect(h.lines.join("\n")).toContain("nimbus connector migrate accept m-1");
    expect(h.disconnects()).toBe(1);
  });

  test("list --json prints the rows verbatim", async () => {
    const h = harness([{ migrations: [ROW] }]);
    await runConnectorMigrate(["list", "--json"], h.io);
    expect(JSON.parse(h.lines.join("\n"))).toEqual([ROW]);
  });

  test("accept with a piped stdin refuses at the CLI, before any connection", async () => {
    const h = harness([], { stdin: false, stdout: true });
    await expect(runConnectorMigrate(["accept", "m-1"], h.io)).rejects.toThrow(
      /non-TTY mode: the approval must be answered at a terminal/,
    );
    expect(h.opened).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("accept with stdout redirected refuses too", async () => {
    const h = harness([], { stdin: true, stdout: false });
    await expect(runConnectorMigrate(["accept", "m-1"], h.io)).rejects.toThrow(/non-TTY/);
    expect(h.opened).toEqual([]);
  });

  test("accept has no --yes", async () => {
    const h = harness([]);
    await expect(runConnectorMigrate(["accept", "m-1", "--yes"], h.io)).rejects.toThrow(/no --yes/);
    expect(h.opened).toEqual([]);
  });

  test("accept requires an id", async () => {
    const h = harness([]);
    await expect(runConnectorMigrate(["accept"], h.io)).rejects.toThrow(/migrate accept <id>/);
  });

  test("accept answers the gateway's prompt at the terminal and reports the move", async () => {
    const h = harness(
      [{ ...ROW, state: "approved" }, undefined],
      { stdin: true, stdout: true },
      true,
    );
    await runConnectorMigrate(["accept", "m-1"], h.io);
    expect(h.calls[0]).toEqual({ method: "migration.accept", params: { id: "m-1" } });
    expect(h.lines.join("\n")).toContain("fixturewise now runs as the extension");
    // The consent prompt handler is registered on the connection: a request is answered.
    h.emit("consent.request", { requestId: "r1", prompt: "extension.migrate …" });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls[1]).toEqual({
      method: "consent.respond",
      params: { requestId: "r1", approved: true },
    });
  });

  test("ignores NIMBUS_SCRIPT_CONSENT_SOURCE: the prompt handler answers, never the script", async () => {
    const prior = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
    process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = "approve-all";
    try {
      const h = harness([{ ...ROW, state: "approved" }, undefined], undefined, false);
      await runConnectorMigrate(["accept", "m-1"], h.io);
      h.emit("consent.request", { requestId: "r2", prompt: "p" });
      await new Promise((r) => setTimeout(r, 0));
      expect(h.calls[1]).toEqual({
        method: "consent.respond",
        params: { requestId: "r2", approved: false },
      });
    } finally {
      if (prior === undefined) delete process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
      else process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"] = prior;
    }
  });

  test("a 'no' says the migration is still awaiting approval and names decline", async () => {
    const h = harness([
      new Error("ERR_EXTENSION_MIGRATION_NOT_APPROVED: moving fixturewise was not approved"),
    ]);
    const err = await runConnectorMigrate(["accept", "m-1"], h.io).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("still awaiting approval");
    expect(msg).toContain("nimbus connector migrate decline m-1");
    expect(h.disconnects()).toBe(1);
  });

  test("any other accept failure propagates unchanged", async () => {
    const h = harness([new Error("ERR_EXTENSION_MIGRATION_FAILED: the staged package is missing")]);
    await expect(runConnectorMigrate(["accept", "m-1"], h.io)).rejects.toThrow(
      /ERR_EXTENSION_MIGRATION_FAILED/,
    );
  });

  test("decline is its own verb and names retry as the way back", async () => {
    const h = harness([{ ...ROW, state: "declined" }]);
    await runConnectorMigrate(["decline", "m-1"], h.io);
    expect(h.calls).toEqual([{ method: "migration.decline", params: { id: "m-1" } }]);
    expect(h.lines.join("\n")).toContain("nimbus connector migrate retry");
  });

  test("retry calls migration.retry and prints the rows", async () => {
    const h = harness([{ migrations: [{ ...ROW, state: "failed", error: "offline" }] }]);
    await runConnectorMigrate(["retry"], h.io);
    expect(h.calls).toEqual([{ method: "migration.retry", params: {} }]);
    expect(h.lines.join("\n")).toContain("error: offline");
  });

  test("an unknown verb prints the usage", async () => {
    const h = harness([]);
    await expect(runConnectorMigrate(["frobnicate"], h.io)).rejects.toThrow(
      /nimbus connector migrate list/,
    );
  });

  test("a malformed list response is refused", async () => {
    const h = harness([{ migrations: [{ id: 1 }] }]);
    await expect(runConnectorMigrate(["list"], h.io)).rejects.toThrow(/malformed/);
  });
});

describe("formatMigrationRows", () => {
  test("no rows", () => {
    expect(formatMigrationRows([])).toEqual(["No connector migrations."]);
  });

  test("an approved row has no next step; a declined one names retry", () => {
    const lines = formatMigrationRows([
      { ...ROW, state: "approved" },
      { ...ROW, id: "m-2", state: "declined" },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain("to change your mind");
  });
});

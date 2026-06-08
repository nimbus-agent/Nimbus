import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { ADMIN_TOKEN_VAULT_KEY, type AdminIpc, parseAdminArgs, runAdminCommand } from "./admin.ts";

function fakeClient(responses: ReadonlyArray<unknown> = []): {
  client: AdminIpc;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let idx = 0;
  const client: AdminIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      const r = idx < responses.length ? responses[idx] : { ok: true };
      idx += 1;
      return r as T;
    },
  };
  return { client, calls };
}

describe("parseAdminArgs", () => {
  it("defaults to status when no subcommand is given", () => {
    expect(parseAdminArgs([])).toEqual({ kind: "status" });
  });

  it("parses status", () => {
    expect(parseAdminArgs(["status"])).toEqual({ kind: "status" });
  });

  it("parses console", () => {
    expect(parseAdminArgs(["console"])).toEqual({ kind: "console" });
  });

  it("parses token", () => {
    expect(parseAdminArgs(["token"])).toEqual({ kind: "token" });
  });

  it("throws on an unknown subcommand", () => {
    expect(() => parseAdminArgs(["bogus"])).toThrow("Unknown subcommand: bogus");
  });
});

describe("runAdminCommand", () => {
  const cap = createStreamCapture();

  beforeEach(() => {
    cap.install();
  });
  afterEach(() => {
    cap.restore();
    cap.stdoutChunks.length = 0;
    cap.stderrChunks.length = 0;
    delete process.env["NIMBUS_HTTP_PORT"];
  });
  afterAll(() => {
    cap.restore();
  });

  it("status calls admin.status and prints the snapshot", async () => {
    const { client, calls } = fakeClient([{ uptimeMs: 1234, connectors: 7 }]);
    await runAdminCommand(client, { kind: "status" });
    expect(calls[0]).toEqual({ method: "admin.status", params: {} });
    const out = cap.stdoutChunks.join("");
    expect(out).toContain('"uptimeMs": 1234');
    expect(out).toContain('"connectors": 7');
  });

  it("console prints a URL with the token in the fragment, never the query string", async () => {
    process.env["NIMBUS_HTTP_PORT"] = "8745";
    const { client, calls } = fakeClient();
    await runAdminCommand(client, { kind: "console" });
    // console is local-only: no IPC round-trip.
    expect(calls).toHaveLength(0);
    const out = cap.stdoutChunks.join("");
    expect(out).toContain("#token=");
    expect(out).not.toContain("?token=");
    expect(out).toContain("http://127.0.0.1:8745/admin");
    expect(out).toContain(ADMIN_TOKEN_VAULT_KEY);
  });

  it("console falls back to a placeholder port when NIMBUS_HTTP_PORT is unset", async () => {
    const { client } = fakeClient();
    await runAdminCommand(client, { kind: "console" });
    const out = cap.stdoutChunks.join("");
    expect(out).toContain("<NIMBUS_HTTP_PORT>");
    expect(out).toContain("#token=");
    expect(out).not.toContain("?token=");
  });

  it("token prints the vault-get guidance without an IPC call", async () => {
    const { client, calls } = fakeClient();
    await runAdminCommand(client, { kind: "token" });
    expect(calls).toHaveLength(0);
    const out = cap.stdoutChunks.join("");
    expect(out).toContain(`nimbus vault get ${ADMIN_TOKEN_VAULT_KEY}`);
    expect(out).not.toContain("?token=");
  });
});

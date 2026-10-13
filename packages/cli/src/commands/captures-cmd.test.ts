import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { CAPTURES_USAGE, runCapturesCmd } from "./captures.ts";

// runCapturesCmd is the argv → IPC wrapper; runCapturesWith's behaviour is covered in
// captures.test.ts. These pin the wrapper's own contract: usage → exit 2, a gateway refusal
// → exit 1, success → no throw, with output on the real process streams.

function streams(): { out: () => string; err: () => string; restore: () => void } {
  let out = "";
  let err = "";
  const o = spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out += String(s);
    return true;
  });
  const e = spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    err += String(s);
    return true;
  });
  return {
    out: () => out,
    err: () => err,
    restore: () => {
      o.mockRestore();
      e.mockRestore();
    },
  };
}

function useIpc(responses: ReadonlyArray<unknown>): ReturnType<typeof createMockIpcClient> {
  const ipc = createMockIpcClient(responses);
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
  });
  return ipc;
}

afterEach(() => clearFixture());

describe("runCapturesCmd", () => {
  test("bad argv prints usage and exits 2 without calling the gateway", async () => {
    const s = streams();
    try {
      const err = await runCapturesCmd(["show"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(2);
      expect(s.err()).toBe(`${CAPTURES_USAGE}\n`);
    } finally {
      s.restore();
    }
  });

  test("a successful revoke writes to stdout and does not throw", async () => {
    const ipc = useIpc([{ ok: true }]);
    const s = streams();
    try {
      await runCapturesCmd(["revoke", "cap_1"]);
      expect(ipc.calls).toEqual([{ method: "captures.revoke", params: { id: "cap_1" } }]);
      expect(s.out()).toContain("Revoked cap_1");
    } finally {
      s.restore();
    }
  });

  test("a gateway refusal writes to stderr and exits 1", async () => {
    useIpc([new Error("ERR_CAPTURE_NOT_FOUND")]);
    const s = streams();
    try {
      const err = await runCapturesCmd(["revoke", "cap_missing"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliExit);
      expect((err as CliExit).code).toBe(1);
      expect(s.err()).toContain("ERR_CAPTURE_NOT_FOUND");
    } finally {
      s.restore();
    }
  });
});

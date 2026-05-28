import { describe, expect, test } from "bun:test";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

describe("checkLanMethodAllowed", () => {
  test("allows read methods without grant-write", () => {
    expect(() =>
      checkLanMethodAllowed("index.search", { peerId: "p", writeAllowed: false }),
    ).not.toThrow();
  });

  test("rejects forbidden namespaces regardless of grant-write", () => {
    for (const method of ["vault.list", "updater.checkNow", "lan.grantWrite", "profile.create"]) {
      expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
        LanError,
      );
    }
  });

  test("rejects write method without grant — rpcCode -32603", () => {
    try {
      checkLanMethodAllowed("engine.ask", { peerId: "p", writeAllowed: false });
      throw new Error("expected");
    } catch (err) {
      expect(err).toBeInstanceOf(LanError);
      expect((err as LanError).rpcCode).toBe(-32603);
      expect((err as LanError).message).toMatch(/ERR_LAN_WRITE_FORBIDDEN/);
    }
  });

  test("allows write method with grant", () => {
    expect(() =>
      checkLanMethodAllowed("engine.ask", { peerId: "p", writeAllowed: true }),
    ).not.toThrow();
  });

  test("rejects audit namespace regardless of grant-write", () => {
    expect(() =>
      checkLanMethodAllowed("audit.export", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
    expect(() => checkLanMethodAllowed("audit.list", { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });

  test("rejects data namespace regardless of grant-write", () => {
    expect(() => checkLanMethodAllowed("data.delete", { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
    expect(() => checkLanMethodAllowed("data.export", { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });

  test("rejects connector.addMcp regardless of grant-write", () => {
    expect(() =>
      checkLanMethodAllowed("connector.addMcp", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
  });

  test("rejects connector.addMcp even with writeAllowed false (also forbidden, not just write-gated)", () => {
    expect(() =>
      checkLanMethodAllowed("connector.addMcp", { peerId: "p", writeAllowed: false }),
    ).toThrow(LanError);
    let thrown: LanError | undefined;
    try {
      checkLanMethodAllowed("connector.addMcp", { peerId: "p", writeAllowed: false });
    } catch (e) {
      thrown = e as LanError;
    }
    expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
  });
});

describe("extension.sync over LAN", () => {
  test("rejected by checkLanMethodAllowed (T2 PR 2 / I5)", () => {
    expect(() =>
      checkLanMethodAllowed("extension.sync", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
  });
});

describe("security namespace over LAN", () => {
  test("rejected by checkLanMethodAllowed regardless of grant-write (I5)", () => {
    expect(() =>
      checkLanMethodAllowed("security.scan", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
    expect(() =>
      checkLanMethodAllowed("security.scan", { peerId: "p", writeAllowed: false }),
    ).toThrow(LanError);
  });
});

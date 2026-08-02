import { describe, expect, test } from "bun:test";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";

describe("checkLanMethodAllowed", () => {
  test("allows read methods without grant-write", () => {
    expect(() =>
      checkLanMethodAllowed("index.search", { peerId: "p", writeAllowed: false }),
    ).not.toThrow();
  });

  test("rejects forbidden namespaces regardless of grant-write", () => {
    for (const method of [
      "vault.list",
      "updater.checkNow",
      "lan.grantWrite",
      "profile.create",
      "chatops.status",
      "chatops.start",
      "tribal.status",
      "tribal.list",
      "tribal.capture",
    ]) {
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

describe("extension management over LAN (I5 — CLI-only)", () => {
  test("install/enable/disable/remove are forbidden over LAN regardless of grant-write", () => {
    for (const m of [
      "extension.install",
      "extension.enable",
      "extension.disable",
      "extension.remove",
    ]) {
      // forbidden even with writeAllowed: true (fully forbidden, not merely write-gated)
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: true })).toThrow(LanError);
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: false })).toThrow(
        LanError,
      );
    }
  });

  test("extension.install rejection is ERR_METHOD_NOT_ALLOWED (not merely write-forbidden)", () => {
    let thrown: LanError | undefined;
    try {
      checkLanMethodAllowed("extension.install", { peerId: "p", writeAllowed: true });
    } catch (e) {
      thrown = e as LanError;
    }
    expect(thrown).toBeInstanceOf(LanError);
    expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
  });
});

describe("share over LAN (I5 — Slice 8)", () => {
  test("share.create + share.prune + share.approvalRespond are fully forbidden over LAN regardless of grant-write", () => {
    for (const m of ["share.create", "share.prune", "share.approvalRespond"]) {
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: true })).toThrow(LanError);
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: false })).toThrow(
        LanError,
      );
    }
  });

  test("share.create rejection is ERR_METHOD_NOT_ALLOWED (fully forbidden, not merely write-gated)", () => {
    let thrown: LanError | undefined;
    try {
      checkLanMethodAllowed("share.create", { peerId: "p", writeAllowed: true });
    } catch (e) {
      thrown = e as LanError;
    }
    expect(thrown).toBeInstanceOf(LanError);
    expect(thrown?.rpcCode).toBe(-32601);
    expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
  });

  test("the four share reads are admitted over LAN (default-allow)", () => {
    const peer = { peerId: "p", writeAllowed: false };
    for (const m of ["share.verify", "share.list", "share.get", "share.pubkey"]) {
      expect(() => checkLanMethodAllowed(m, peer)).not.toThrow();
    }
  });
});

describe("federation over LAN (I5 + I17)", () => {
  const peer = { peerId: "p", writeAllowed: false };

  test("federation.query and federation.expertise are admitted over LAN", () => {
    expect(() => checkLanMethodAllowed("federation.query", peer)).not.toThrow();
    expect(() => checkLanMethodAllowed("federation.expertise", peer)).not.toThrow();
  });

  test("federation.policy is admitted over LAN (read-only signed bundle)", () => {
    expect(() => checkLanMethodAllowed("federation.policy", peer)).not.toThrow();
  });

  test("federation.auditExport is admitted over LAN (consent-gated, metadata-only slice)", () => {
    expect(() => checkLanMethodAllowed("federation.auditExport", peer)).not.toThrow();
  });

  test("federation management methods are forbidden over LAN", () => {
    for (const m of [
      "federation.discover",
      "federation.pair",
      "federation.peers",
      "federation.namespace.publish",
      "federation.namespace.grant",
      "federation.namespace.revoke",
    ]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
    }
  });

  test("local-only owner/asker methods are forbidden over LAN (consentRespond/ask/askExpertise)", () => {
    for (const m of ["federation.consentRespond", "federation.ask", "federation.askExpertise"]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
    }
  });

  test("vault/data/extension remain forbidden over LAN", () => {
    for (const m of ["vault.get", "data.export", "extension.sync"]) {
      expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
    }
  });

  test("federation.shareForward is forbidden over LAN; federation.shareReceive is answerable", () => {
    // shareForward is the local-only asker entrypoint (like federation.ask) — forbidden over LAN.
    expect(() => checkLanMethodAllowed("federation.shareForward", peer)).toThrow(LanError);
    expect(() => checkLanMethodAllowed("federation.shareForward", peer)).toThrow(
      /not callable over LAN/,
    );
    // shareReceive is the answering method (how shares arrive over the wire) — must stay admitted.
    expect(() => checkLanMethodAllowed("federation.shareReceive", peer)).not.toThrow();
  });
});

describe("glossary over LAN (I5 — on-demand passes are write-class and local-only)", () => {
  test("forbids the glossary namespace over LAN", () => {
    const peer = { peerId: "p1", writeAllowed: true };
    expect(() => checkLanMethodAllowed("glossary.refresh", peer)).toThrow("not callable over LAN");
    expect(() => checkLanMethodAllowed("glossary.rebuild", peer)).toThrow("not callable over LAN");
    // The read-only agent stays reachable, like the other nine agents.
    expect(() => checkLanMethodAllowed("agents.glossary", peer)).not.toThrow();
  });
});

describe("decisions over LAN (I5 — on-demand passes are write-class and local-only)", () => {
  test("forbids the decisions namespace over LAN", () => {
    const peer = { peerId: "p1", writeAllowed: true };
    expect(() => checkLanMethodAllowed("decisions.refresh", peer)).toThrow("not callable over LAN");
    expect(() => checkLanMethodAllowed("decisions.rebuild", peer)).toThrow("not callable over LAN");
    // The read-only agent stays reachable, like the other nine agents.
    expect(() => checkLanMethodAllowed("agents.decisions", peer)).not.toThrow();
  });
});

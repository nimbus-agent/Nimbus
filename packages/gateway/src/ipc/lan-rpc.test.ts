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

  test("rejects the media namespace regardless of grant-write (I5, S2 multimodal I/O)", () => {
    expect(() =>
      checkLanMethodAllowed("media.understand", { peerId: "p", writeAllowed: true }),
    ).toThrow(LanError);
    expect(() =>
      checkLanMethodAllowed("media.understand", { peerId: "p", writeAllowed: false }),
    ).toThrow(LanError);
  });

  /**
   * PR 4's three consent-management methods. Consent to send a user's photos to a third party is
   * the local owner's to give, and a LAN peer must never be able to grant it — nor to ENUMERATE
   * which artifacts the owner has already exposed, which is why `media.grants.list` is forbidden
   * too even though it writes nothing: it is a read, but a read of exactly the fact I27/I30-style
   * reasoning treats as sensitive. All three ride the pre-existing `media` NAMESPACE forbid rather
   * than needing a new entry — this test is the proof that they actually do, not an assumption.
   */
  test.each(["media.allowRemote", "media.grants.list", "media.grants.revoke"])(
    "%s is LAN-forbidden regardless of grant-write",
    (method) => {
      expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
        LanError,
      );
      expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: false })).toThrow(
        LanError,
      );
    },
  );

  /**
   * The whole `fleet` namespace, for two independent reasons: `fleet.runNow` spends the owner's
   * CPU (and, under `[fleet] allow_remote`, their frontier budget) on unattended work, and
   * `fleet.briefs`/`fleet.show` hand back last night's synthesised answers over the private index.
   * Asserted on the MESSAGE, not just the class, because the namespace forbid and the write gate
   * throw the same `LanError` — a `toThrow(LanError)` alone would pass if `fleet` were merely
   * write-gated, which is exactly what this must not be.
   *
   * These methods are served from Task 9 onward; the forbid is deliberately in place first, since
   * `checkLanMethodAllowed` is a pure string check and a namespace that arrives already closed
   * cannot be opened by an oversight in the commit that adds the handlers.
   */
  test.each(["fleet.runNow", "fleet.briefs", "fleet.show", "fleet.status", "fleet.digest"])(
    "%s is not callable over LAN regardless of grant-write",
    (method) => {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed })).toThrow(
          /not callable over LAN/,
        );
      }
    },
  );

  /**
   * The whole `toolgen` namespace (S2 runtime tool generation), matching exec/computer/media/
   * fleet above. `toolgen.create` is RCE-class by definition -- it registers model-authored code
   * that then runs -- and `toolgen.approvalRespond` is the LOCAL owner answering a registration
   * prompt; admitting either over the wire would let a paired peer approve LLM-authored code
   * running on the owner's machine with the owner's credentials, defeating the entire I39 gate.
   * Asserted on the MESSAGE, not just the class, for the same reason as fleet above: the namespace
   * forbid and the write gate throw the same `LanError`.
   */
  test.each(["toolgen.create", "toolgen.approvalRespond", "toolgen.list", "toolgen.revoke"])(
    "%s is not callable over LAN regardless of grant-write",
    (method) => {
      for (const writeAllowed of [true, false]) {
        expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed })).toThrow(
          /not callable over LAN/,
        );
      }
    },
  );

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

describe("ownership over LAN (I5 — on-demand passes are write-class and local-only)", () => {
  test("forbids the ownership namespace over LAN", () => {
    const peer = { peerId: "p1", writeAllowed: true };
    expect(() => checkLanMethodAllowed("agents.ownership", peer)).not.toThrow();
    expect(() => checkLanMethodAllowed("ownership.refresh", peer)).toThrow(/not callable over LAN/);
  });
});

describe("premortem over LAN (I5 — writes local rows and spends the local model budget)", () => {
  test("premortem.refresh is forbidden over LAN", () => {
    // It writes local rows and can spend the local model budget. Only the
    // read-only agents.premortem brief (PR B, a separate namespace) is LAN-reachable.
    const peer = { peerId: "p1", writeAllowed: true };
    expect(() => checkLanMethodAllowed("premortem.refresh", peer)).toThrow(/not callable over LAN/);
  });
});

describe("index.rebody over LAN (I5 — drives outbound third-party API traffic)", () => {
  test("index.rebody and index.rebodyCancel are forbidden over LAN regardless of grant-write", () => {
    for (const m of ["index.rebody", "index.rebodyCancel"]) {
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: true })).toThrow(LanError);
      expect(() => checkLanMethodAllowed(m, { peerId: "p", writeAllowed: false })).toThrow(
        LanError,
      );
    }
  });

  test("index.rebody rejection is ERR_METHOD_NOT_ALLOWED (fully forbidden, not merely write-gated)", () => {
    let thrown: LanError | undefined;
    try {
      checkLanMethodAllowed("index.rebody", { peerId: "p", writeAllowed: true });
    } catch (e) {
      thrown = e as LanError;
    }
    expect(thrown).toBeInstanceOf(LanError);
    expect(thrown?.rpcCode).toBe(-32601);
    expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
  });
});

describe("clip over LAN (I5 / I30 — pairing must stay owner-opened)", () => {
  test("forbids the clip namespace over LAN regardless of grant-write", () => {
    for (const peer of [
      { peerId: "p1", writeAllowed: true },
      { peerId: "p1", writeAllowed: false },
    ]) {
      // clip.pair opens the I30 pairing window and returns the one-time code; admitting it over
      // LAN would let a paired peer mint its own clip token without the owner ever running
      // `nimbus clip pair`. Proven on a second method too, to show the namespace entry is doing
      // the work rather than a coincidental single-method match.
      expect(() => checkLanMethodAllowed("clip.pair", peer)).toThrow(LanError);
      expect(() => checkLanMethodAllowed("clip.status", peer)).toThrow(LanError);
    }
  });

  test("clip.pair rejection is ERR_METHOD_NOT_ALLOWED (fully forbidden, not merely write-gated)", () => {
    let thrown: LanError | undefined;
    try {
      checkLanMethodAllowed("clip.pair", { peerId: "p", writeAllowed: true });
    } catch (e) {
      thrown = e as LanError;
    }
    expect(thrown).toBeInstanceOf(LanError);
    expect(thrown?.rpcCode).toBe(-32601);
    expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
  });
});

describe("demo over LAN (I41 clause 5 — the demo seeder is local CLI only)", () => {
  test("forbids demo.seed over LAN regardless of grant-write", () => {
    for (const peer of [
      { peerId: "p1", writeAllowed: true },
      { peerId: "p1", writeAllowed: false },
    ]) {
      let thrown: LanError | undefined;
      try {
        checkLanMethodAllowed("demo.seed", peer);
      } catch (e) {
        thrown = e as LanError;
      }
      expect(thrown).toBeInstanceOf(LanError);
      expect(thrown?.rpcCode).toBe(-32601);
      expect(thrown?.message).toMatch(/ERR_METHOD_NOT_ALLOWED/);
    }
  });

  // Negative control: the namespace entry is doing the work, not a coincidental broader match.
  test("agents.ownership is still allowed", () => {
    expect(() =>
      checkLanMethodAllowed("agents.ownership", { peerId: "p1", writeAllowed: false }),
    ).not.toThrow();
  });
});

describe("tour and locality over LAN (nimbus wow)", () => {
  test("tour.* and locality.* are refused over LAN; agents.ownership is still admitted", () => {
    const peer = { peerId: "p", writeAllowed: true };
    expect(() => checkLanMethodAllowed("tour.plan", peer)).toThrow(/not callable over LAN/);
    expect(() => checkLanMethodAllowed("locality.report", peer)).toThrow(/not callable over LAN/);
    expect(() => checkLanMethodAllowed("agents.ownership", peer)).not.toThrow(); // negative control
  });
});

test("both local-auth methods are refused over LAN; a sibling connector read is not", () => {
  const peer = { peerId: "p", writeAllowed: true };
  for (const m of ["connector.detectLocalAuth", "connector.adoptLocalAuth"]) {
    expect(() => checkLanMethodAllowed(m, peer)).toThrow(LanError);
  }
  // Negative control: the denylist is not simply refusing every connector.* method.
  expect(() => checkLanMethodAllowed("connector.listStatus", peer)).not.toThrow();
});

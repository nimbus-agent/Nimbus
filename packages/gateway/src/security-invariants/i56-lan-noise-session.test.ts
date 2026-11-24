import { describe, expect, test } from "bun:test";
import {
  checkLanBoxPathConfinement,
  RULE_ANCHORS,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { DEFAULT_NIMBUS_LAN_TOML } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import {
  attackerEeCandidates,
  attackLegacyBox,
  attackTransport,
  ratchetScenario,
  recordSession,
  replayRecordedRequest,
} from "../ipc/testing/lan-forward-secrecy.test-helpers.ts";
import {
  oldPairFrameScenario,
  recordPairingScenario,
  wrongCodeScenario,
} from "../ipc/testing/lan-pairing.test-helpers.ts";

describe("I56 — a LAN session's records are encrypted only under ephemeral-DH Noise keys; no v1 path exists", () => {
  test("FS-A1: given BOTH static secrets and the whole transcript, no record opens; the positive control opens", async () => {
    const real = await recordSession(false);
    try {
      const opened = attackTransport(real.conn, {
        initiator: real.initiator,
        responder: real.responder,
        eeCandidates: attackerEeCandidates(real),
      });
      expect(opened).toBe(0);
      expect(attackLegacyBox(real.conn, real.initiator, real.responder)).toBe(0);
    } finally {
      await real.stop();
    }
    const control = await recordSession(true);
    try {
      const opened = attackTransport(control.conn, {
        initiator: control.initiator,
        responder: control.responder,
        eeCandidates: [control.controlEe as Uint8Array],
      });
      // If the attacker routine were broken, the zero above would prove nothing; this is the guard.
      expect(opened).toBeGreaterThanOrEqual(2);
    } finally {
      await control.stop();
    }
  });

  test("FS-A2: a replayed message 1 and recorded request never execute, and the failure is counted", async () => {
    const out = await replayRecordedRequest();
    expect(out.messageTwoDiffers).toBe(true);
    expect(out.executedAfter).toBe(out.executedBefore);
    expect(out.bytesAfterMessage2).toBe(0);
    expect(out.closed).toBe(true);
    expect(out.failures).toBe(1);
  });

  test("FS-A3: one v2 session ratchets the peer, and an old-wire hello for it then gets no reply", async () => {
    const out = await ratchetScenario();
    expect(out.hostRowBefore).toBe(1);
    expect(out.hostRowAfter).toBe(2);
    expect(out.askerRowAfter).toBe(2);
    expect(out.legacyHelloClosed).toBe(true);
    expect(out.legacyHelloBytes).toBe(0);
  });

  test("FS3: no v1 path exists - no legacy module, no downgrade check, no box seal, and the server refuses the old first byte", async () => {
    const ipcFiles = await readDirFiles("packages/gateway/src/ipc");
    expect(ipcFiles.filter((f) => /(?:^|\/)lan-legacy/.test(f.rel))).toEqual([]);
    const crypto = stripComments(await read("packages/gateway/src/ipc/lan-crypto.ts"));
    expect(crypto).not.toMatch(/\b(?:sealBoxFrame|openBoxFrame)\b/);
    expect(crypto).not.toMatch(/\bnacl\s*\.\s*box\s*(?:\.\s*open\s*)?\(/);
    for (const rel of ["lan-server.ts", "lan-client.ts", "lan-wire.ts", "lan-session.ts"]) {
      const src = stripComments(await read(`packages/gateway/src/ipc/${rel}`));
      expect(src).not.toContain("lan-legacy");
      expect(src).not.toContain("legacyAllowedFor");
      expect(src).not.toContain("minProtocol");
    }
    const link = stripComments(await read("packages/gateway/src/federation/lan-link.ts"));
    expect(link).not.toContain("minProtocol");
    // The one decision on the first byte: the old wire's `{` is refused (no reply, counted), never routed.
    const server = stripComments(await read("packages/gateway/src/ipc/lan-server.ts"));
    const branchAt = server.indexOf("OLD_WIRE_FIRST_BYTE) this.opts.onOldWireRefused");
    const failAt = server.indexOf("this.opts.rateLimit.recordFailure(state.peerIp)", branchAt);
    const endAt = server.indexOf("state.writer.end()", failAt);
    expect(branchAt).toBeGreaterThan(-1);
    expect(failAt).toBeGreaterThan(branchAt);
    expect(endAt).toBeGreaterThan(failAt);
    expect(server).not.toMatch(/mode\s*=\s*"legacy"/);
    // The owner is told which peer to upgrade: the boot wires the refusal notice and the stale-config warning.
    const boot = stripComments(
      await read("packages/gateway/src/platform/assemble/federation-boot.ts"),
    );
    expect(boot).toContain("oldWireNotices(paths.logDir, lanCfg.minProtocolIgnored)");
    expect(boot).toContain("onOldWireRefused: oldWire.refused");
  });

  test("wiring: the server uses lan-session for v2, and checkLanMethodAllowed runs before onMessage", async () => {
    const server = stripComments(await read("packages/gateway/src/ipc/lan-server.ts"));
    expect(server).toContain("openResponderHandshake(");
    // checkLanMethodAllowed still runs before onMessage on the v2 path.
    const gateAt = server.indexOf("checkLanMethodAllowed(method, peer)");
    const dispatchAt = server.indexOf("this.opts.onMessage(method, params, peer)");
    // Both must exist: a removed check would make indexOf -1, which is "before" everything.
    expect(gateAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(dispatchAt);
    const client = stripComments(await read("packages/gateway/src/ipc/lan-client.ts"));
    expect(client).toContain("createInitiatorHandshake(");
  });

  test("source pins: neither host file seals with the static key, and production never injects an ephemeral", async () => {
    for (const rel of [
      "lan-server.ts",
      "lan-client.ts",
      "lan-session.ts",
      "lan-noise.ts",
      "lan-pair-server.ts",
      "lan-pair-client.ts",
      "lan-pair-session.ts",
      "lan-pairing.ts",
    ]) {
      const src = stripComments(await read(`packages/gateway/src/ipc/${rel}`));
      expect(src).not.toMatch(/\b(?:sealBoxFrame|openBoxFrame)\b/);
      expect(src).not.toMatch(/\bnacl\s*\.\s*box\s*(?:\.\s*open\s*)?\(/);
    }
    for (const rel of ["lan-server.ts", "lan-client.ts"]) {
      const src = stripComments(await read(`packages/gateway/src/ipc/${rel}`));
      expect(src).not.toContain("generateEphemeral");
    }
    // lan-session.ts only FORWARDS the optional test hook; it never supplies a value of its own.
    const session = stripComments(await read("packages/gateway/src/ipc/lan-session.ts"));
    const uses = session.match(/generateEphemeral[^\n]*/g) ?? [];
    for (const u of uses) {
      expect(u).toMatch(
        /generateEphemeral\??: \(\(\) => BoxKeypair\) \| undefined|generateEphemeral: opts\.generateEphemeral/,
      );
    }
    const federation = await readDirFiles("packages/gateway/src/federation");
    for (const f of federation) expect(f.contents).not.toMatch(/\b(?:sealBoxFrame|openBoxFrame)\b/);
  });

  test("D47: the static rule is wired, anchored, and the real tree passes it", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkLanBoxPathConfinement(files)");
    expect(RULE_ANCHORS).toContain("packages/gateway/src/ipc/lan-session.ts");
    expect(RULE_ANCHORS).not.toContain("packages/gateway/src/ipc/lan-legacy.ts");
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkLanBoxPathConfinement(files)).toEqual([]);
    const rogue = {
      relPath: "packages/gateway/src/federation/rogue.ts",
      contents: 'import { sealBoxFrame } from "../ipc/lan-crypto.ts";\nsealBoxFrame(a, b, c);',
    };
    expect(checkLanBoxPathConfinement([...files, rogue]).map((v) => v.rule)).toContain(
      "lan-box-path-confined",
    );
    // The old wire cannot come back under its old name, and no file is exempt any more.
    const revived = { relPath: "packages/gateway/src/ipc/lan-legacy.ts", contents: "export {};" };
    expect(checkLanBoxPathConfinement([...files, revived]).map((v) => v.file)).toContain(
      revived.relPath,
    );
    const crypto = {
      relPath: "packages/gateway/src/ipc/lan-crypto.ts",
      contents: "export const seal = (m) => nacl.box(m, n, p, s);",
    };
    expect(checkLanBoxPathConfinement([crypto])).toHaveLength(1);
  });

  test("FS2: a recorded pairing holds no code, PSK or static key; both statics and the PSK do not open it; the control does", async () => {
    const r = await recordPairingScenario();
    expect(r.wireHasCode).toBe(false);
    expect(r.wireHasPsk).toBe(false);
    expect(r.wireHasInitiatorStatic).toBe(false);
    expect(r.wireHasHostStatic).toBe(false);
    expect(r.attackerOpened).toBe(0);
    // If the attacker routine were broken, the zero above would prove nothing; this is the guard.
    expect(r.controlOpened).toBe(true);
  });

  test("FS2: a wrong pairing code gets no reply at message 1, one counted failure, and does not burn the window", async () => {
    const out = await wrongCodeScenario();
    expect(out.closed).toBe(true);
    expect(out.bytesReceived).toBe(0);
    expect(out.failures).toBe(1);
    expect(out.windowStillOpen).toBe(true);
    expect(out.rightCodeThenPaired).toBe(true);
  });

  test("FS3: the old plaintext `pair` frame gets no reply and consumes nothing", async () => {
    const out = await oldPairFrameScenario();
    expect(out.closed).toBe(true);
    expect(out.bytesReceived).toBe(0);
    expect(out.windowStillOpen).toBe(true);
    expect(out.registered).toBe(0);
  });

  test("FS2 wiring: the initiator never builds a plaintext pair frame, the responder consumes the window only after message 3 opens", async () => {
    for (const rel of ["lan-client.ts", "lan-pair-client.ts", "lan-pair-session.ts"]) {
      const src = stripComments(await read(`packages/gateway/src/ipc/${rel}`));
      expect(src).not.toContain("pairing_code");
      expect(src).not.toContain('kind: "pair"');
      expect(src).not.toContain("lan-legacy");
    }
    const client = stripComments(await read("packages/gateway/src/ipc/lan-pair-client.ts"));
    // The test hook is forwarded, never supplied; production callers do not pass it.
    const forwards = client.match(/generateEphemeral[^\n]*/g) ?? [];
    for (const u of forwards) {
      expect(u).toMatch(
        /generateEphemeral\??: \(\(\) => BoxKeypair\) \| undefined|generateEphemeral: opts\.generateEphemeral/,
      );
    }
    const runtime = stripComments(
      await read("packages/gateway/src/federation/federation-runtime.ts"),
    );
    expect(runtime).not.toContain("generateEphemeral");
    const server = stripComments(await read("packages/gateway/src/ipc/lan-pair-server.ts"));
    const finishAt = server.indexOf("responder.finish(message3)");
    const consumeAt = server.indexOf("consumeOpen()");
    const registerAt = server.indexOf("ctx.registerPeer(");
    expect(finishAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(finishAt);
    expect(registerAt).toBeGreaterThan(consumeAt);
    // The v2 path never uses the plaintext code check, and registers at protocol 2.
    expect(server).not.toContain(".consume(");
    expect(server).toContain("ctx.registerPeer(finished.remoteStatic, host.peerIp, 2)");
  });

  test("the protocol column stays (status names a peer still on 1) and the config key is gone", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(95);
    expect("minProtocol" in DEFAULT_NIMBUS_LAN_TOML).toBe(false);
  });
});

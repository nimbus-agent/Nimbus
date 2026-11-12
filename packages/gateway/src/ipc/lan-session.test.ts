import { describe, expect, test } from "bun:test";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { CipherState, HandshakeState, NOISE_OPEN_FAILED, PATTERN_IK } from "./lan-noise.ts";
import {
  createInitiatorHandshake,
  decodeFirstFrame,
  encodeFirstFrame,
  MAX_LOGICAL_MESSAGE,
  MAX_RECORD_CHUNK,
  openResponderHandshake,
  REKEY_EVERY_RECORDS,
  SESSION_PROTOCOL_ERROR,
  SESSION_TOO_LARGE,
  Session,
} from "./lan-session.ts";

function establish() {
  const si = generateBoxKeypair();
  const sr = generateBoxKeypair();
  const init = createInitiatorHandshake({ s: si, rs: sr.publicKey });
  const resp = openResponderHandshake(init.firstFrameBody, { s: sr });
  const { message2, session: server } = resp.accept();
  const client = init.finish(message2);
  return { client, server, si, sr, init, resp, message2 };
}

function bytes(n: number, fill = 0xab): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

function roundTrip(sender: Session, receiver: Session, message: Uint8Array): Uint8Array {
  const records = sender.sealMessage(message);
  let out: Uint8Array | undefined;
  for (const [i, r] of records.entries()) {
    out = receiver.openRecord(r);
    if (i < records.length - 1) expect(out).toBeUndefined();
  }
  return out as Uint8Array;
}

describe("handshake drivers", () => {
  test("the initiator's first frame is the header then message 1, and decodes back", () => {
    const { init, resp, si } = establish();
    expect([...init.firstFrameBody.subarray(0, 4)]).toEqual([0x4e, 0x4c, 0x02, 0x01]);
    expect(resp.remoteStatic).toEqual(si.publicKey);
    const m1 = decodeFirstFrame(init.firstFrameBody) as Uint8Array;
    expect(encodeFirstFrame(m1)).toEqual(init.firstFrameBody);
  });

  test("message 1 and message 2 carry no payload (D-FS-4): both are exactly the Noise overhead", () => {
    const { init, message2 } = establish();
    // IK message 1: e(32) + encrypted s(32+16) + payload tag(16); message 2: e(32) + payload tag(16).
    expect(init.firstFrameBody.length).toBe(4 + 32 + 48 + 16);
    expect(message2.length).toBe(32 + 16);
  });

  test("any other magic, version or pattern byte is not a v2 first frame", () => {
    const { init } = establish();
    const base = init.firstFrameBody;
    for (const [index, value] of [
      [0, 0x7b],
      [1, 0x4d],
      [2, 0x03],
      [3, 0x07],
      [3, 0x02],
    ] as const) {
      const bad = base.slice();
      bad[index] = value;
      expect(decodeFirstFrame(bad)).toBeUndefined();
    }
    expect(decodeFirstFrame(new Uint8Array([0x4e, 0x4c, 0x02]))).toBeUndefined();
  });

  test("a responder refuses a bad header, a message 1 that does not open and a wrong pinned key", () => {
    const sr = generateBoxKeypair();
    const { init } = establish();
    const badHeader = init.firstFrameBody.slice();
    badHeader[2] = 0x03;
    expect(() => openResponderHandshake(badHeader, { s: sr })).toThrow(NOISE_OPEN_FAILED);
    // Encrypted to somebody else's static key: this responder cannot open it.
    expect(() => openResponderHandshake(init.firstFrameBody, { s: sr })).toThrow(NOISE_OPEN_FAILED);
    const truncated = init.firstFrameBody.slice(0, 40);
    expect(() => openResponderHandshake(truncated, { s: sr })).toThrow(NOISE_OPEN_FAILED);
  });

  test("a message 2 that does not open fails the initiator with the fixed error", () => {
    const { message2 } = establish();
    const sr = generateBoxKeypair();
    const init = createInitiatorHandshake({ s: generateBoxKeypair(), rs: sr.publicKey });
    const resp = openResponderHandshake(init.firstFrameBody, { s: sr });
    const bad = resp.accept().message2;
    bad[40] = (bad[40] as number) ^ 1;
    const other = createInitiatorHandshake({
      s: generateBoxKeypair(),
      rs: generateBoxKeypair().publicKey,
    });
    expect(() => other.finish(message2)).toThrow(NOISE_OPEN_FAILED);
    expect(() => init.finish(bad)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a handshake message with a payload is refused on both sides", () => {
    // Build raw messages through the engine with a non-empty payload.
    const si = generateBoxKeypair();
    const sr = generateBoxKeypair();
    {
      const prologue = new Uint8Array([...new TextEncoder().encode("nimbus-lan/2"), 0x02, 0x01]);
      const i = new HandshakeState({
        pattern: PATTERN_IK,
        initiator: true,
        prologue,
        s: si,
        rs: sr.publicKey,
      });
      const m1 = i.writeMessage(new Uint8Array([1]));
      expect(() => openResponderHandshake(encodeFirstFrame(m1), { s: sr })).toThrow(
        NOISE_OPEN_FAILED,
      );

      const init2 = createInitiatorHandshake({ s: si, rs: sr.publicKey });
      const r = new HandshakeState({ pattern: PATTERN_IK, initiator: false, prologue, s: sr });
      r.readMessage(init2.firstFrameBody.subarray(4));
      const m2 = r.writeMessage(new Uint8Array([1]));
      expect(() => init2.finish(m2)).toThrow(NOISE_OPEN_FAILED);
    }
  });
});

describe("records", () => {
  const sizes = [0, 1, MAX_RECORD_CHUNK, MAX_RECORD_CHUNK + 1, MAX_LOGICAL_MESSAGE];

  for (const n of sizes) {
    test(`a ${String(n)}-byte message round-trips, flag 0 on all but the last record`, () => {
      const { client, server } = establish();
      const message = bytes(n, 0x5a);
      const records = client.sealMessage(message);
      expect(records.length).toBe(Math.max(1, Math.ceil(n / MAX_RECORD_CHUNK)));
      for (const r of records) expect(r.length).toBeLessThanOrEqual(65_535);
      let out: Uint8Array | undefined;
      for (const r of records) out = server.openRecord(r);
      expect(out).toEqual(message);
    });
  }

  test("a message one byte over 4 MiB is refused before any record is made", () => {
    const { client } = establish();
    expect(() => client.sealMessage(bytes(MAX_LOGICAL_MESSAGE + 1))).toThrow(SESSION_TOO_LARGE);
    expect(() => client.sealMessage(bytes(1))).toThrow(SESSION_PROTOCOL_ERROR);
  });

  test("the reassembler refuses a stream past 4 MiB as it goes, before buffering it whole", () => {
    // A hostile peer streams flag-0 records forever; build them with the real key schedule.
    const key = new Uint8Array(32).fill(3);
    const sendCs = new CipherState(key);
    const session = new Session(new CipherState(undefined), new CipherState(key));
    const chunk = bytes(MAX_RECORD_CHUNK, 1);
    const plain = new Uint8Array(1 + chunk.length);
    plain.set(chunk, 1); // flag 0x00: more follows
    let opened = 0;
    expect(() => {
      for (;;) {
        session.openRecord(sendCs.encryptWithAd(new Uint8Array(0), plain));
        opened += 1;
      }
    }).toThrow(SESSION_TOO_LARGE);
    expect(opened).toBe(Math.floor(MAX_LOGICAL_MESSAGE / MAX_RECORD_CHUNK));
  });

  function rawRecord(key: Uint8Array, plain: Uint8Array): { session: Session; record: Uint8Array } {
    return {
      session: new Session(new CipherState(undefined), new CipherState(key)),
      record: new CipherState(key).encryptWithAd(new Uint8Array(0), plain),
    };
  }

  test("a flag other than 0 or 1, and an empty record, end the session with a fixed error", () => {
    const key = new Uint8Array(32).fill(4);
    const bad = rawRecord(key, new Uint8Array([0x02, 1, 2]));
    expect(() => bad.session.openRecord(bad.record)).toThrow(SESSION_PROTOCOL_ERROR);
    expect(() => bad.session.openRecord(bad.record)).toThrow(SESSION_PROTOCOL_ERROR);
    const empty = rawRecord(key, new Uint8Array(0));
    expect(() => empty.session.openRecord(empty.record)).toThrow(SESSION_PROTOCOL_ERROR);
  });

  test("a record that does not open ends the session, and so does a replayed one", () => {
    const { client, server } = establish();
    const [record] = client.sealMessage(bytes(5));
    const tampered = (record as Uint8Array).slice();
    tampered[0] = (tampered[0] as number) ^ 1;
    expect(() => server.openRecord(tampered)).toThrow(NOISE_OPEN_FAILED);
    expect(() => server.openRecord(record as Uint8Array)).toThrow(SESSION_PROTOCOL_ERROR);

    const a = establish();
    const [r1] = a.client.sealMessage(bytes(5));
    a.server.openRecord(r1 as Uint8Array);
    expect(() => a.server.openRecord(r1 as Uint8Array)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a message that follows a completed one starts a new logical message", () => {
    const { client, server } = establish();
    expect(roundTrip(client, server, bytes(3, 1))).toEqual(bytes(3, 1));
    expect(roundTrip(client, server, bytes(4, 2))).toEqual(bytes(4, 2));
  });

  test("replies flow the other way under their own keys", () => {
    const { client, server } = establish();
    expect(roundTrip(server, client, bytes(70_000, 9))).toEqual(bytes(70_000, 9));
    // A client record does not open under the client's own receive state.
    const [r] = client.sealMessage(bytes(2));
    expect(() => client.openRecord(r as Uint8Array)).toThrow(NOISE_OPEN_FAILED);
  });
});

describe("rekey (OR-FS-3: every 1,024 records per CipherState)", () => {
  test("the constant is 1,024", () => {
    expect(REKEY_EVERY_RECORDS).toBe(1024);
  });

  test("2,100 records: both sides stay in step, and the key changes after record 1,024 and 2,048", () => {
    const { client, server } = establish();
    const seen: string[] = [client.keyFingerprints().send];
    for (let i = 1; i <= 2100; i++) {
      const out = roundTrip(client, server, new Uint8Array([i & 0xff]));
      expect(out[0]).toBe(i & 0xff);
      if (i === 1023 || i === 1024 || i === 2047 || i === 2048) {
        seen.push(client.keyFingerprints().send);
        expect(server.keyFingerprints().receive).toBe(client.keyFingerprints().send);
      }
    }
    expect(seen[1]).toBe(seen[0]); // after 1,023 records: unchanged
    expect(seen[2]).not.toBe(seen[1]); // after 1,024: rekeyed
    expect(seen[3]).toBe(seen[2]); // after 2,047: unchanged
    expect(seen[4]).not.toBe(seen[3]); // after 2,048: rekeyed again
  });

  test("a receiver told to skip the rekey fails at record 1,025", () => {
    const key = new Uint8Array(32).fill(5);
    const sender = new Session(new CipherState(key), new CipherState(undefined));
    const receiver = new Session(new CipherState(undefined), new CipherState(key), {
      rekeyEveryRecords: 1_000_000,
    });
    for (let i = 1; i <= 1024; i++) {
      receiver.openRecord(
        (sender.sealMessage(new Uint8Array([1])) as Uint8Array[])[0] as Uint8Array,
      );
    }
    const next = sender.sealMessage(new Uint8Array([1]))[0] as Uint8Array;
    expect(() => receiver.openRecord(next)).toThrow(NOISE_OPEN_FAILED);
  });

  test("a receiver that rekeys at 1,025 instead of 1,024 fails the same way", () => {
    const key = new Uint8Array(32).fill(5);
    const sender = new Session(new CipherState(key), new CipherState(undefined));
    const receiver = new Session(new CipherState(undefined), new CipherState(key), {
      rekeyEveryRecords: 1025,
    });
    for (let i = 1; i <= 1024; i++) {
      receiver.openRecord(sender.sealMessage(new Uint8Array([1]))[0] as Uint8Array);
    }
    expect(() =>
      receiver.openRecord(sender.sealMessage(new Uint8Array([1]))[0] as Uint8Array),
    ).toThrow(NOISE_OPEN_FAILED);
  });

  test("asymmetric traffic: 1,500 records one way and 20 the other, each direction on its own counter", () => {
    const { client, server } = establish();
    const before = {
      cSend: client.keyFingerprints().send,
      cRecv: client.keyFingerprints().receive,
    };
    for (let i = 0; i < 1500; i++) roundTrip(client, server, new Uint8Array([1]));
    for (let i = 0; i < 20; i++) roundTrip(server, client, new Uint8Array([2]));
    expect(client.keyFingerprints().send).not.toBe(before.cSend); // rekeyed once at 1,024
    expect(client.keyFingerprints().receive).toBe(before.cRecv); // only 20 records: not yet
    expect(server.keyFingerprints().receive).toBe(client.keyFingerprints().send);
    expect(server.keyFingerprints().send).toBe(client.keyFingerprints().receive);
    // And both still talk.
    expect(roundTrip(client, server, new Uint8Array([7]))[0]).toBe(7);
    expect(roundTrip(server, client, new Uint8Array([8]))[0]).toBe(8);
  });

  test("rekey is one-way: a key from before the rekey cannot open a record sent after it", () => {
    const key = new Uint8Array(32).fill(6);
    const sender = new Session(new CipherState(key), new CipherState(undefined));
    let last: Uint8Array = new Uint8Array(0);
    for (let i = 1; i <= 1030; i++)
      last = sender.sealMessage(new Uint8Array([i & 0xff]))[0] as Uint8Array;
    // Record 1,030 has counter 1,029 and was sealed under the once-rekeyed key.
    const stale = new CipherState(key, 1029n);
    expect(() => stale.decryptWithAd(new Uint8Array(0), last)).toThrow(NOISE_OPEN_FAILED);
    const fresh = new CipherState(key, 1029n);
    fresh.rekey();
    expect(fresh.decryptWithAd(new Uint8Array(0), last)[0]).toBe(0x01);
  });
});

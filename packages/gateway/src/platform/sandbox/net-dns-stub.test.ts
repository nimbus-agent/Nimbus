import { describe, expect, test } from "bun:test";
import { answerDnsQuery, type DnsNames } from "./net-dns-stub.ts";

function ascii(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "latin1"));
}

function labelBytes(name: string | Uint8Array[]): number[] {
  const labels = typeof name === "string" ? name.split(".").map(ascii) : name;
  const out: number[] = [];
  for (const l of labels) out.push(l.length, ...l);
  out.push(0);
  return out;
}

type HeaderOptions = { id?: number; flags?: number; qd?: number; ar?: number };

function header(over: HeaderOptions = {}): number[] {
  const id = over.id ?? 0xbeef;
  const flags = over.flags ?? 0x0100;
  const qd = over.qd ?? 1;
  const ar = over.ar ?? 0;
  return [id >> 8, id & 0xff, flags >> 8, flags & 0xff, 0, qd, 0, 0, 0, 0, 0, ar];
}

function query(
  name: string | Uint8Array[],
  qtype = 1,
  over: HeaderOptions = {},
  qclass = 1,
): Uint8Array {
  return Uint8Array.from([...header(over), ...labelBytes(name), 0, qtype, 0, qclass]);
}

/**
 * A question whose one label starts with `lenByte` and is followed by exactly the `lenByte`'s
 * value in bytes, then a terminator, type and class. Read as a plain label it would be valid, so
 * only the length-above-63 check can reject it.
 */
function rawLabelQuery(lenByte: number, padding: number): Uint8Array {
  return Uint8Array.from([
    ...header(),
    lenByte,
    ...new Array<number>(padding).fill(0x61),
    0,
    0,
    1,
    0,
    1,
  ]);
}

function parse(reply: Uint8Array | null) {
  if (reply === null) throw new Error("expected a reply");
  const v = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
  return {
    id: v.getUint16(0),
    flags: v.getUint16(2),
    rcode: v.getUint16(2) & 0xf,
    an: v.getUint16(6),
    ar: v.getUint16(10),
    bytes: reply,
  };
}

const map = new Map([["api.github.com", "127.0.0.2"]]);
function makeNames(over: Partial<DnsNames> = {}): DnsNames & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    isDeclared: (n) => {
      seen.push(n);
      return map.has(n);
    },
    hasRoom: () => true,
    addressFor: (n) => map.get(n) ?? null,
    ...over,
  };
}

describe("answerDnsQuery", () => {
  test("A for a declared name: NOERROR with one A record", () => {
    const r = answerDnsQuery(query("api.github.com"), makeNames());
    const p = parse(r.reply);
    expect(p.rcode).toBe(0);
    expect(p.an).toBe(1);
    expect(p.id).toBe(0xbeef);
    expect(p.flags & 0x8000).toBe(0x8000);
    expect(p.flags & 0x0100).toBe(0x0100);
    expect(Array.from(p.bytes.slice(-4))).toEqual([127, 0, 0, 2]);
    expect(r.refusedName).toBeNull();
  });

  test("the whole A reply: header counts, question echo and answer record", () => {
    const q = query("api.github.com");
    const bytes = answerDnsQuery(q, makeNames()).reply;
    if (bytes === null) throw new Error("expected a reply");
    // id, flags (QR + RD, NOERROR), QD 1, AN 1, NS 0, AR 0
    expect(Array.from(bytes.slice(0, 12))).toEqual([
      0xbe, 0xef, 0x81, 0x00, 0, 1, 0, 1, 0, 0, 0, 0,
    ]);
    expect(Array.from(bytes.slice(12, q.length))).toEqual(Array.from(q.slice(12)));
    expect(Array.from(bytes.slice(q.length))).toEqual([
      0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 2,
    ]);
    expect(bytes.length).toBe(q.length + 16);
  });

  test("A in a class other than IN is NOERROR with no answers", () => {
    const names = makeNames({
      addressFor: () => {
        throw new Error("must not be called");
      },
    });
    const p = parse(answerDnsQuery(query("api.github.com", 1, {}, 3), names).reply);
    expect(p.rcode).toBe(0);
    expect(p.an).toBe(0);
  });

  test("MX on a declared name with no room is NOERROR, no answers, no refusal", () => {
    const r = answerDnsQuery(query("api.github.com", 15), makeNames({ hasRoom: () => false }));
    const p = parse(r.reply);
    expect(p.rcode).toBe(0);
    expect(p.an).toBe(0);
    expect(r.refusedName).toBeNull();
  });

  test("the root name is NXDOMAIN and is not logged", () => {
    const names = makeNames();
    const q = Uint8Array.from([...header(), 0, 0, 1, 0, 1]);
    const r = answerDnsQuery(q, names);
    expect(parse(r.reply).rcode).toBe(3);
    expect(r.refusedName).toBeNull();
    expect(names.seen).toEqual([]);
  });

  test("AAAA for a declared name: NOERROR, no answers, addressFor never called", () => {
    const names = makeNames({
      addressFor: () => {
        throw new Error("must not be called");
      },
    });
    const r = answerDnsQuery(query("api.github.com", 28), names);
    const p = parse(r.reply);
    expect(p.rcode).toBe(0);
    expect(p.an).toBe(0);
    expect(r.refusedName).toBeNull();
  });

  test("an undeclared name is NXDOMAIN for A and AAAA, and is reported", () => {
    for (const t of [1, 28]) {
      const r = answerDnsQuery(query("evil.example", t), makeNames());
      expect(parse(r.reply).rcode).toBe(3);
      expect(parse(r.reply).an).toBe(0);
      expect(r.refusedName).toBe("evil.example");
    }
  });

  test("a declared name with no room is SERVFAIL for A and AAAA, with no slot taken", () => {
    for (const t of [1, 28]) {
      let calls = 0;
      const names = makeNames({
        hasRoom: () => false,
        addressFor: () => {
          calls += 1;
          return "127.0.0.2";
        },
      });
      const r = answerDnsQuery(query("api.github.com", t), names);
      expect(parse(r.reply).rcode).toBe(2);
      expect(r.refusedName).toBe("api.github.com");
      expect(calls).toBe(0);
    }
  });

  test("another type on a declared name is NOERROR with no answers", () => {
    const r = answerDnsQuery(query("api.github.com", 15), makeNames());
    expect(parse(r.reply).rcode).toBe(0);
    expect(parse(r.reply).an).toBe(0);
  });

  test("a null address from the pool is SERVFAIL", () => {
    const r = answerDnsQuery(query("api.github.com"), makeNames({ addressFor: () => null }));
    expect(parse(r.reply).rcode).toBe(2);
    expect(r.refusedName).toBe("api.github.com");
  });

  test("lower-cases for the callbacks and echoes the question bytes and id", () => {
    const names = makeNames();
    const q = query("API.GitHub.COM", 1, { id: 0x1234 });
    const r = answerDnsQuery(q, names);
    expect(names.seen).toEqual(["api.github.com"]);
    const p = parse(r.reply);
    expect(p.id).toBe(0x1234);
    expect(Array.from(p.bytes.slice(12, q.length))).toEqual(Array.from(q.slice(12)));
    expect(p.an).toBe(1);
  });

  test("a byte above 0x7F is undeclared and never reaches the callbacks", () => {
    const names = makeNames();
    const r = answerDnsQuery(query([Uint8Array.from([0xc1, 0x70, 0x69])]), names);
    expect(names.seen).toEqual([]);
    expect(parse(r.reply).rcode).toBe(3);
    expect(r.refusedName).toBe("pi");
  });

  test("a control byte in a label is stripped from refusedName and the name is undeclared", () => {
    const names = makeNames();
    const r = answerDnsQuery(
      query([Uint8Array.from([0x65, 0x01, 0x76, 0x0a, 0x7f]), ascii("example")]),
      names,
    );
    expect(names.seen).toEqual([]);
    expect(parse(r.reply).rcode).toBe(3);
    expect(r.refusedName).toBe("ev.example");
  });

  test("a dot byte inside a label cannot pose as two labels", () => {
    const names = makeNames();
    const r = answerDnsQuery(query([ascii("api.github.com")]), names);
    expect(names.seen).toEqual([]);
    expect(parse(r.reply).rcode).toBe(3);
  });

  test("the longest legal name (255 wire bytes) is answered, and reported whole", () => {
    const labels = [63, 63, 63, 61].map((n) => ascii("a".repeat(n)));
    const r = answerDnsQuery(query(labels), makeNames());
    expect(parse(r.reply).rcode).toBe(3);
    expect(r.refusedName?.length).toBe(63 * 3 + 61 + 3);
  });

  test("an EDNS OPT record is ignored and the reply carries ARCOUNT 0", () => {
    const opt = [0, 0, 41, 0x10, 0, 0, 0, 0, 0, 0, 0];
    const q = Uint8Array.from([...query("api.github.com", 1, { ar: 1 }), ...opt]);
    const p = parse(answerDnsQuery(q, makeNames()).reply);
    expect(p.rcode).toBe(0);
    expect(p.an).toBe(1);
    expect(p.ar).toBe(0);
  });

  test("recursion desired is copied, and absent when the query had none", () => {
    const p = parse(answerDnsQuery(query("api.github.com", 1, { flags: 0 }), makeNames()).reply);
    expect(p.flags & 0x0100).toBe(0);
  });

  describe("malformed or unanswerable queries return a null reply without throwing", () => {
    const good = Array.from(query("api.github.com"));
    const cases: Record<string, Uint8Array> = {
      empty: new Uint8Array(0),
      "shorter than a header": Uint8Array.from(good.slice(0, 11)),
      "no question": Uint8Array.from(good.slice(0, 12)),
      "QDCOUNT 0": query("a.b", 1, { qd: 0 }),
      "QDCOUNT 2": query("a.b", 1, { qd: 2 }),
      "compression pointer type 0xC0": rawLabelQuery(0xc0, 192),
      "reserved label type 0x80": rawLabelQuery(0x80, 128),
      "extended label type 0x40": rawLabelQuery(0x40, 64),
      "label past the end": Uint8Array.from([...header(), 50, 0x61, 0x62]),
      "missing type and class": Uint8Array.from(good.slice(0, good.length - 3)),
      "label over 63 bytes": query([ascii("a".repeat(64))]),
      "name over 255 bytes": query(Array.from({ length: 6 }, () => ascii("a".repeat(60)))),
      "name of 256 wire bytes": query([63, 63, 63, 62].map((n) => ascii("a".repeat(n)))),
      "a response, not a query": query("api.github.com", 1, { flags: 0x8100 }),
      "opcode 1 (IQUERY)": query("api.github.com", 1, { flags: 0x0800 }),
      "opcode 4 (NOTIFY)": query("api.github.com", 1, { flags: 0x2000 }),
    };
    for (const [label, bytes] of Object.entries(cases)) {
      test(label, () => {
        const names = makeNames();
        expect(answerDnsQuery(bytes, names)).toEqual({ reply: null, refusedName: null });
        expect(names.seen).toEqual([]);
      });
    }
  });

  test("a view with a nonzero byteOffset is parsed from its own start", () => {
    const q = query("api.github.com");
    const backing = new Uint8Array(q.length + 7);
    backing.set(q, 7);
    const r = answerDnsQuery(backing.subarray(7), makeNames());
    expect(parse(r.reply).an).toBe(1);
  });
});

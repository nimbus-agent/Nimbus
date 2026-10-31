/**
 * The stub resolver behind the sandbox's `127.0.0.53`. Pure: bytes in, bytes out, no socket and
 * no lookup. It runs in the wrapper outside the sandbox on a datagram the child wrote, so it
 * parses only the 12-byte header and the one question, every read bounded by the buffer.
 *
 * A declared name gets a loopback address from the caller's pool, any other name gets NXDOMAIN,
 * and no query ever leaves the machine.
 */

export type DnsNames = {
  isDeclared(name: string): boolean;
  /** False only for a matching name that holds no pool slot when the pool is full. */
  hasRoom(name: string): boolean;
  /** Called only for an `A` query on a declared name, so `AAAA` never takes a slot. */
  addressFor(name: string): string | null;
};

export type DnsAnswer = {
  /** The datagram to send back, or null when the query is not one this resolver answers. */
  reply: Uint8Array | null;
  /** The sanitised name behind an NXDOMAIN or SERVFAIL, for the rate-limited log. */
  refusedName: string | null;
};

const HEADER_LENGTH = 12;
const MAX_NAME_WIRE_LENGTH = 255;
const MAX_LABEL_LENGTH = 63;
const MAX_REFUSED_NAME_LENGTH = 255;
const ANSWER_TTL_SECONDS = 60;

const TYPE_A = 1;
const TYPE_AAAA = 28;
const CLASS_IN = 1;

const RCODE_NOERROR = 0;
const RCODE_SERVFAIL = 2;
const RCODE_NXDOMAIN = 3;

type ParsedQuery = {
  id: number;
  recursionDesired: boolean;
  /** The question exactly as the child sent it: name, type and class. */
  question: Uint8Array;
  /** Lower-cased name with no trailing dot, or null when a label holds a byte we never pass on. */
  name: string | null;
  /** The name with every byte outside printable ASCII stripped, for logging. */
  logName: string;
  qtype: number;
  qclass: number;
};

type QuestionName = { end: number; name: string | null; logName: string };

/** A label byte we hand to the callbacks: printable ASCII, and not the dot that joins labels. */
function isNameByte(b: number): boolean {
  return b >= 0x21 && b <= 0x7e && b !== 0x2e;
}

/** Lower-cases A-Z only, so a byte above 0x7F can never turn into ASCII. */
function asciiLower(b: number): number {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

/**
 * Reads the question's name from `start`. Labels only: a length byte above 63 (a compression
 * pointer or an extended label) is malformed. Each pass advances at least one byte and the loop
 * stops at the buffer end or at 255 wire bytes.
 */
function readQuestionName(q: Uint8Array, start: number): QuestionName | null {
  const labels: string[] = [];
  const logLabels: string[] = [];
  let clean = true;
  let pos = start;
  while (pos < q.length && pos - start < MAX_NAME_WIRE_LENGTH) {
    const len = q[pos] ?? 0;
    pos += 1;
    if (len === 0) {
      return { end: pos, name: clean ? labels.join(".") : null, logName: logLabels.join(".") };
    }
    if (len > MAX_LABEL_LENGTH || pos + len > q.length) return null;
    let label = "";
    let logLabel = "";
    for (let i = 0; i < len; i += 1) {
      const b = q[pos + i] ?? 0;
      if (b >= 0x20 && b <= 0x7e) logLabel += String.fromCharCode(b);
      if (isNameByte(b)) label += String.fromCharCode(asciiLower(b));
      else clean = false;
    }
    pos += len;
    labels.push(label);
    logLabels.push(logLabel);
  }
  return null;
}

function parseQuery(q: Uint8Array): ParsedQuery | null {
  if (q.length < HEADER_LENGTH) return null;
  const view = new DataView(q.buffer, q.byteOffset, q.byteLength);
  const flags = view.getUint16(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0xf;
  if (isResponse || opcode !== 0) return null;
  if (view.getUint16(4) !== 1) return null;
  const parsed = readQuestionName(q, HEADER_LENGTH);
  if (parsed === null) return null;
  const end = parsed.end + 4;
  if (end > q.length) return null;
  return {
    id: view.getUint16(0),
    recursionDesired: (flags & 0x0100) !== 0,
    question: q.slice(HEADER_LENGTH, end),
    name: parsed.name,
    logName: parsed.logName.slice(0, MAX_REFUSED_NAME_LENGTH),
    qtype: view.getUint16(parsed.end),
    qclass: view.getUint16(parsed.end + 2),
  };
}

/** The 4 bytes of a dotted-quad, or null. The caller's pool only ever holds loopback addresses. */
function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function buildReply(query: ParsedQuery, rcode: number, address: number[] | null): Uint8Array {
  const answerLength = address === null ? 0 : 16;
  const out = new Uint8Array(HEADER_LENGTH + query.question.length + answerLength);
  const view = new DataView(out.buffer);
  view.setUint16(0, query.id);
  view.setUint16(2, 0x8000 | (query.recursionDesired ? 0x0100 : 0) | rcode);
  view.setUint16(4, 1);
  view.setUint16(6, address === null ? 0 : 1);
  out.set(query.question, HEADER_LENGTH);
  if (address !== null) {
    const pos = HEADER_LENGTH + query.question.length;
    view.setUint16(pos, 0xc00c); // the name: a pointer back to the question
    view.setUint16(pos + 2, TYPE_A);
    view.setUint16(pos + 4, CLASS_IN);
    view.setUint32(pos + 6, ANSWER_TTL_SECONDS);
    view.setUint16(pos + 10, 4);
    out.set(address, pos + 12);
  }
  return out;
}

function refuse(query: ParsedQuery, rcode: number): DnsAnswer {
  return { reply: buildReply(query, rcode, null), refusedName: query.logName };
}

/** Answers one DNS query datagram. Never throws on malformed input: it returns a null reply. */
export function answerDnsQuery(query: Uint8Array, names: DnsNames): DnsAnswer {
  const parsed = parseQuery(query);
  if (parsed === null) return { reply: null, refusedName: null };
  const name = parsed.name;
  if (name === null || !names.isDeclared(name)) return refuse(parsed, RCODE_NXDOMAIN);
  const isAddressQuery = parsed.qtype === TYPE_A || parsed.qtype === TYPE_AAAA;
  if (isAddressQuery && !names.hasRoom(name)) return refuse(parsed, RCODE_SERVFAIL);
  if (parsed.qtype !== TYPE_A || parsed.qclass !== CLASS_IN) {
    return { reply: buildReply(parsed, RCODE_NOERROR, null), refusedName: null };
  }
  const address = ipv4Bytes(names.addressFor(name) ?? "");
  if (address === null) return refuse(parsed, RCODE_SERVFAIL);
  return { reply: buildReply(parsed, RCODE_NOERROR, address), refusedName: null };
}

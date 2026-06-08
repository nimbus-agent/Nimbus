import type { QuorumRule } from "../config/nimbus-toml.ts";
import {
  isTableHeader,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "../config/toml-primitives.ts";
import type { OrgPolicy } from "./types.ts";

const QUORUM_PREFIX = '[policy.hitl.quorum."';

/** Mutable accumulator threaded through the per-section key handlers. */
interface PolicyAccum {
  version: number;
  org: string;
  issuedAt: string | undefined;
  allow: string[] | undefined;
  minDays: number;
  require: string[];
  shipTo: string | undefined;
  shipFormat: string | undefined;
  /** Raw key/value pairs per quorum id, finalized after the scan. */
  quorumAccum: Map<string, Record<string, string>>;
}

function applyPolicyKey(acc: PolicyAccum, key: string, valRaw: string): void {
  if (key === "version") acc.version = parseIntDec(valRaw) ?? 0;
  else if (key === "org") acc.org = parseString(valRaw);
  else if (key === "issued_at") acc.issuedAt = parseString(valRaw);
}

function applyConnectorsKey(acc: PolicyAccum, key: string, valRaw: string): void {
  if (key === "allow") acc.allow = [...parseStringArray(valRaw)];
}

function applyRetentionKey(acc: PolicyAccum, key: string, valRaw: string): void {
  if (key === "min_days") acc.minDays = parseIntDec(valRaw) ?? 0;
}

function applyHitlKey(acc: PolicyAccum, key: string, valRaw: string): void {
  if (key === "require") acc.require = [...parseStringArray(valRaw)];
}

function applyAuditKey(acc: PolicyAccum, key: string, valRaw: string): void {
  if (key === "ship_to") acc.shipTo = parseString(valRaw);
  else if (key === "ship_format") acc.shipFormat = parseString(valRaw);
}

function applyQuorumKey(
  acc: PolicyAccum,
  quorumId: string | undefined,
  key: string,
  valRaw: string,
): void {
  if (quorumId === undefined) return;
  const bucket = acc.quorumAccum.get(quorumId);
  if (bucket !== undefined) bucket[key] = valRaw;
}

/** Route one key/value pair to the section that owns it. */
function dispatchKey(
  acc: PolicyAccum,
  section: string,
  quorumId: string | undefined,
  key: string,
  valRaw: string,
): void {
  switch (section) {
    case "[policy]":
      applyPolicyKey(acc, key, valRaw);
      break;
    case "[policy.connectors]":
      applyConnectorsKey(acc, key, valRaw);
      break;
    case "[policy.retention]":
      applyRetentionKey(acc, key, valRaw);
      break;
    case "[policy.hitl]":
      applyHitlKey(acc, key, valRaw);
      break;
    case "[policy.audit]":
      applyAuditKey(acc, key, valRaw);
      break;
    case "quorum":
      applyQuorumKey(acc, quorumId, key, valRaw);
      break;
    default:
      break;
  }
}

/** Resolve a table header into the next section + active quorum id (if any). */
function readHeader(acc: PolicyAccum, trimmed: string): { section: string; quorumId?: string } {
  if (trimmed.startsWith(QUORUM_PREFIX) && trimmed.endsWith('"]')) {
    const id = trimmed.slice(QUORUM_PREFIX.length, -2);
    if (id.length === 0) return { section: "quorum" };
    if (!acc.quorumAccum.has(id)) acc.quorumAccum.set(id, {});
    return { section: "quorum", quorumId: id };
  }
  return { section: trimmed };
}

/** Finalize accumulated quorum buckets into the rule map (window>0 + approvers>=1 filter). */
function finalizeQuorum(quorumAccum: Map<string, Record<string, string>>): Map<string, QuorumRule> {
  const quorum = new Map<string, QuorumRule>();
  for (const [id, bucket] of quorumAccum) {
    const approvers = parseIntDec(bucket["approvers"] ?? "") ?? 0;
    const windowSeconds = parseIntDec(bucket["window_seconds"] ?? "") ?? 0;
    if (approvers >= 1 && windowSeconds > 0) quorum.set(id, { approvers, windowSeconds });
  }
  return quorum;
}

/** Parse a canonicalized nimbus.policy.toml string into an OrgPolicy. */
export function parsePolicyToml(source: string): OrgPolicy {
  const acc: PolicyAccum = {
    version: 0,
    org: "",
    issuedAt: undefined,
    allow: undefined,
    minDays: 0,
    require: [],
    shipTo: undefined,
    shipFormat: undefined,
    quorumAccum: new Map<string, Record<string, string>>(),
  };

  let section = "";
  let quorumId: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      const header = readHeader(acc, trimmed);
      section = header.section;
      quorumId = header.quorumId;
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    dispatchKey(acc, section, quorumId, kv.key, kv.valRaw);
  }

  const quorum = finalizeQuorum(acc.quorumAccum);

  return {
    version: acc.version,
    org: acc.org,
    ...(acc.issuedAt === undefined ? {} : { issuedAt: acc.issuedAt }),
    connectors: acc.allow === undefined ? {} : { allow: acc.allow },
    retention: { minDays: acc.minDays },
    hitl: { require: acc.require, quorum },
    audit: {
      ...(acc.shipTo === undefined ? {} : { shipTo: acc.shipTo }),
      ...(acc.shipFormat === undefined ? {} : { shipFormat: acc.shipFormat }),
    },
  };
}

/** Render a string array as a TOML inline array literal: `["a", "b"]`. */
function tomlStringArray(values: readonly string[]): string {
  const quoted = values.map((v) => `"${v}"`).join(", ");
  return `[${quoted}]`;
}

/** Serialize an OrgPolicy back to canonical-ish TOML (used by the anchor editor + round-trip tests). */
export function serializePolicyToml(p: OrgPolicy): string {
  const lines: string[] = ["[policy]", `version = ${p.version}`, `org = "${p.org}"`];
  if (p.issuedAt !== undefined) lines.push(`issued_at = "${p.issuedAt}"`);
  if (p.connectors.allow !== undefined) {
    lines.push("", "[policy.connectors]", `allow = ${tomlStringArray(p.connectors.allow)}`);
  }
  lines.push(
    "",
    "[policy.retention]",
    `min_days = ${p.retention.minDays}`,
    "",
    "[policy.hitl]",
    `require = ${tomlStringArray(p.hitl.require)}`,
  );
  for (const [id, rule] of p.hitl.quorum) {
    lines.push(
      "",
      `[policy.hitl.quorum."${id}"]`,
      `approvers = ${rule.approvers}`,
      `window_seconds = ${rule.windowSeconds}`,
    );
  }
  if (p.audit.shipTo !== undefined || p.audit.shipFormat !== undefined) {
    lines.push("", "[policy.audit]");
    if (p.audit.shipTo !== undefined) lines.push(`ship_to = "${p.audit.shipTo}"`);
    if (p.audit.shipFormat !== undefined) lines.push(`ship_format = "${p.audit.shipFormat}"`);
  }
  return `${lines.join("\n")}\n`;
}

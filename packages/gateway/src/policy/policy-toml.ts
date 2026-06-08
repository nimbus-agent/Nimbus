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

/** Parse a canonicalized nimbus.policy.toml string into an OrgPolicy. */
export function parsePolicyToml(source: string): OrgPolicy {
  let version = 0;
  let org = "";
  let issuedAt: string | undefined;
  let allow: string[] | undefined;
  let minDays = 0;
  let require: string[] = [];
  const quorum = new Map<string, QuorumRule>();
  let shipTo: string | undefined;
  let shipFormat: string | undefined;

  let section = "";
  let quorumId: string | undefined;
  const quorumAccum = new Map<string, Record<string, string>>();

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      quorumId = undefined;
      if (trimmed.startsWith(QUORUM_PREFIX) && trimmed.endsWith('"]')) {
        const id = trimmed.slice(QUORUM_PREFIX.length, -2);
        if (id.length > 0) {
          quorumId = id;
          if (!quorumAccum.has(id)) quorumAccum.set(id, {});
        }
        section = "quorum";
      } else {
        section = trimmed;
      }
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    const { key, valRaw } = kv;
    switch (section) {
      case "[policy]":
        if (key === "version") version = parseIntDec(valRaw) ?? 0;
        else if (key === "org") org = parseString(valRaw);
        else if (key === "issued_at") issuedAt = parseString(valRaw);
        break;
      case "[policy.connectors]":
        if (key === "allow") allow = [...parseStringArray(valRaw)];
        break;
      case "[policy.retention]":
        if (key === "min_days") minDays = parseIntDec(valRaw) ?? 0;
        break;
      case "[policy.hitl]":
        if (key === "require") require = [...parseStringArray(valRaw)];
        break;
      case "[policy.audit]":
        if (key === "ship_to") shipTo = parseString(valRaw);
        else if (key === "ship_format") shipFormat = parseString(valRaw);
        break;
      case "quorum":
        if (quorumId !== undefined) {
          const b = quorumAccum.get(quorumId);
          if (b !== undefined) b[key] = valRaw;
        }
        break;
      default:
        break;
    }
  }

  for (const [id, b] of quorumAccum) {
    const approvers = parseIntDec(b["approvers"] ?? "") ?? 0;
    const windowSeconds = parseIntDec(b["window_seconds"] ?? "") ?? 0;
    if (approvers >= 1 && windowSeconds > 0) quorum.set(id, { approvers, windowSeconds });
  }

  return {
    version,
    org,
    ...(issuedAt === undefined ? {} : { issuedAt }),
    connectors: allow === undefined ? {} : { allow },
    retention: { minDays },
    hitl: { require, quorum },
    audit: {
      ...(shipTo === undefined ? {} : { shipTo }),
      ...(shipFormat === undefined ? {} : { shipFormat }),
    },
  };
}

/** Serialize an OrgPolicy back to canonical-ish TOML (used by the anchor editor + round-trip tests). */
export function serializePolicyToml(p: OrgPolicy): string {
  const lines: string[] = ["[policy]", `version = ${p.version}`, `org = "${p.org}"`];
  if (p.issuedAt !== undefined) lines.push(`issued_at = "${p.issuedAt}"`);
  if (p.connectors.allow !== undefined) {
    lines.push(
      "",
      "[policy.connectors]",
      `allow = [${p.connectors.allow.map((c) => `"${c}"`).join(", ")}]`,
    );
  }
  lines.push("", "[policy.retention]", `min_days = ${p.retention.minDays}`);
  lines.push("", "[policy.hitl]", `require = [${p.hitl.require.map((r) => `"${r}"`).join(", ")}]`);
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

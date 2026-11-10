// packages/gateway/src/engine/audit-bodies.ts
// What the audit row and the egress ledger record of a CloudFormation `templateBody` (Phase 9.7 D2)
// and of a Kubernetes `manifest` (D3a): its size and SHA-256, never the text. A template is up to 51,200 bytes of arbitrary text
// (parameter defaults, inline policies, user data), the audit payload is capped at 4096 characters,
// and the credential patterns the redactor knows are not all that a template can hold. What was
// approved is reconciled by the write's `diffSha256` (the SHA-256 of the change set text the owner
// saw) and the connector's own log instead of by storing the template. Beside `audit-files.ts`,
// which does the same for the commit writes' file text.
import { createHash } from "node:crypto";
import { isPlainObject } from "../connectors/connector-writes/preview.ts";
import type { PlannedAction } from "./types.ts";

/**
 * The action types whose `templateBody` is a template: the CloudFormation deploy write and the
 * `iac.write.prepare` read that creates its change set (recognised by its segments so this module
 * names no prepare action-type literal, D42(a)). A test pins this to the bound rows.
 */
export const TEMPLATE_WRITE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "iac.cloudformation.deploy",
  // D3a: the Kubernetes apply carries a manifest of up to 48 KiB (it may name Secrets-adjacent
  // config, image pull settings, annotations); its hash is what the write's `diffSha256` reconciles.
  "kubernetes.manifest.apply",
]);

/** The services whose `<service>.write.prepare` read carries the same kind of text. */
const PREPARE_TEXT_SERVICES: ReadonlySet<string> = new Set(["iac", "kubernetes"]);

/** Whether `type` is the deploy/apply write or the prepare read that carries its template or manifest. */
export function carriesTemplateText(type: string): boolean {
  if (TEMPLATE_WRITE_ACTION_TYPES.has(type)) return true;
  const [service, write, prepare, ...rest] = type.split(".");
  return (
    service !== undefined &&
    PREPARE_TEXT_SERVICES.has(service) &&
    write === "write" &&
    prepare === "prepare" &&
    rest.length === 0
  );
}

/** The text-carrying keys and the names of their size and hash. */
const TEXT_KEYS: ReadonlyArray<readonly [string, string, string, string]> = [
  ["templateBody", "templateBytes", "templateSha256", "templateMalformed"],
  ["manifest", "manifestBytes", "manifestSha256", "manifestMalformed"],
];

/** `holder` with its `templateBody` and `manifest` replaced by size and hash, or `undefined` when it has neither. */
function summariseHolder(
  holder: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  for (const [key, bytesKey, hashKey, malformedKey] of TEXT_KEYS) {
    const current: Record<string, unknown> = out ?? { ...holder };
    if (!Object.hasOwn(current, key)) continue;
    const { [key]: text, ...rest } = current;
    out = {
      ...rest,
      ...(typeof text === "string"
        ? {
            [bytesKey]: Buffer.byteLength(text, "utf8"),
            [hashKey]: createHash("sha256").update(text, "utf8").digest("hex"),
          }
        : { [malformedKey]: true }),
    };
  }
  return out;
}

/**
 * `payload` with every `templateBody` replaced by `templateBytes` and `templateSha256` (or
 * `templateMalformed: true` when it is not text, so a value the gate is about to refuse is not
 * recorded either): the one at `payload.input` AND the one at the payload root. The tool input is
 * the nested one when `input` is present (`extractToolInput` ignores the root then), so a root-level
 * `templateBody` beside it is accepted by the gate and would otherwise reach the record. `undefined`
 * when neither level has a `templateBody` key.
 */
export function omitTemplateText(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const nested = payload["input"];
  const input = Object.hasOwn(payload, "input") && isPlainObject(nested) ? nested : undefined;
  const nestedOut = input === undefined ? undefined : summariseHolder(input);
  const rootOut = summariseHolder(payload);
  if (nestedOut === undefined && rootOut === undefined) return undefined;
  const base = rootOut ?? { ...payload };
  return nestedOut === undefined ? base : { ...base, input: nestedOut };
}

/**
 * `action` with its template text omitted when it is one of the template-carrying types; every
 * other action (and one without `templateBody`) is returned as it is. The ONE rewrite the audit row
 * and the egress ledger both use for a template.
 */
export function withoutTemplateText(action: PlannedAction): PlannedAction {
  if (action.payload === undefined || !carriesTemplateText(action.type)) return action;
  const omitted = omitTemplateText(action.payload);
  return omitted === undefined ? action : { ...action, payload: omitted };
}

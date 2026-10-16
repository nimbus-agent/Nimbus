import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import type { PackageSource, WriteToolRegistration } from "./connector-write-registrations.ts";

/**
 * The action type a write registration declares as `mutates`, read from its call's own text
 * (spec § 6.3). Three shapes, each from `@nimbus-dev/connectors@0.2.4`; anything else is a REASON
 * the sync test reports as a violation — never a skip, the I26 guard's fail-closed rule.
 */
export function resolveRegistrationMutates(
  sources: readonly PackageSource[],
  r: WriteToolRegistration,
): { value: string } | { reason: string } {
  const src = sources.find((s) => s.rel === r.file);
  if (src === undefined) return { reason: `no source for ${r.file}` };
  // `span` indexes the comment-stripped text the scanner read, not the raw file (see its doc).
  const call = stripComments(src.text).slice(r.span[0], r.span[1] + 1);

  const literal = /\bmutates\s*:\s*(["'])([^"'\n]+)\1/.exec(call);
  if (literal?.[2] !== undefined) return { value: literal[2] };

  const tpl = /\bmutates\s*:\s*`([^`]*)`/.exec(call);
  if (tpl?.[1] !== undefined) return fromKitTemplate(call, tpl[1], r.id);

  for (const m of call.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(\s*(["'`])([^"'`\n]+)\2\s*\)/g)) {
    const [, fn, quote, arg] = m;
    if (fn === undefined || arg === undefined || !takesMutatesFirst(sources, fn)) continue;
    // The 0.2.4 imap kit hands its template straight to the helper:
    // `mailSendConsent(`${toolPrefix}.mail.send`)`.
    return quote === "`" ? fromKitTemplate(call, arg, r.id) : { value: arg };
  }
  return { reason: `cannot resolve mutates for ${r.id} in ${r.file}:${String(r.line)}` };
}

/** `${p}_mail_send` id + `${p}.mail.send` mutates: recover p from the resolved id, substitute it. */
function fromKitTemplate(
  call: string,
  mutatesTpl: string,
  id: string,
): { value: string } | { reason: string } {
  const m = /^\$\{([A-Za-z_$][\w$]*)\}(.*)$/.exec(mutatesTpl);
  if (m === null) return { reason: `unsupported mutates template \`${mutatesTpl}\`` };
  const [, ident, mutSuffix] = m;
  const idTpl = new RegExp(String.raw`\(\s*\`\$\{${ident}\}([^\`]*)\``).exec(call);
  const idSuffix = idTpl?.[1];
  if (idSuffix === undefined || !id.endsWith(idSuffix) || id.length === idSuffix.length) {
    return { reason: `id ${id} does not share the template variable ${String(ident)}` };
  }
  return { value: `${id.slice(0, id.length - idSuffix.length)}${mutSuffix ?? ""}` };
}

function takesMutatesFirst(sources: readonly PackageSource[], fn: string): boolean {
  const re = new RegExp(String.raw`function\s+${fn}\s*(?:<[^>]*>)?\s*\(\s*mutates\s*:\s*string`);
  return sources.some((s) => re.test(s.text));
}

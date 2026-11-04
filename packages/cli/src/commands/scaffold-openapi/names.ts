import { isReservedEnv } from "@nimbus-dev/registry-format";
import { own } from "./refs.ts";

/** A credential name is at most this long, suffixes included (the manifest's `[a-z][a-z0-9_]{0,31}`). */
export const MAX_CREDENTIAL_NAME = 32;

function trimUnderscores(s: string, leading: boolean): string {
  let start = 0;
  let end = s.length;
  if (leading) {
    while (start < end && s[start] === "_") start++;
  }
  while (end > start && s[end - 1] === "_") end--;
  return s.slice(start, end);
}

/** Lower-case; every run outside `[a-z0-9]` becomes one `_`; leading and trailing `_` trimmed. */
export function normaliseName(raw: string): string {
  return trimUnderscores(raw.toLowerCase().replaceAll(/[^a-z0-9]+/g, "_"), true);
}

/** The operation's normalised `operationId`, else `<method>_<path segments>`. */
export function toolName(op: Record<string, unknown>, method: string, path: string): string {
  const id = own(op, "operationId");
  if (typeof id === "string") {
    const n = normaliseName(id);
    if (n !== "") return n;
  }
  return normaliseName(`${method}_${path}`);
}

function firstFreeName(name: string, cap: number, taken: ReadonlySet<string>): string {
  let candidate = trimUnderscores(name.slice(0, Math.max(0, cap)), false);
  for (let n = 2; taken.has(candidate); n++) {
    const suffix = `_${n}`;
    candidate = `${trimUnderscores(name.slice(0, Math.max(0, cap - suffix.length)), false)}${suffix}`;
  }
  return candidate;
}

export interface UniqueNames {
  readonly names: readonly string[];
  readonly cut: readonly { readonly from: string; readonly to: string }[];
}

/**
 * Each name cut to `cap` characters and made distinct with `_2`, `_3`, … (the suffix fits inside
 * the cap). A name that had to be shortened is listed in `cut`.
 */
export function uniqueNames(names: readonly string[], cap: number): UniqueNames {
  const taken = new Set<string>();
  const out: string[] = [];
  const cut: { from: string; to: string }[] = [];
  for (const name of names) {
    const final = firstFreeName(name, cap, taken);
    taken.add(final);
    out.push(final);
    if (!final.startsWith(name)) cut.push({ from: name, to: final });
  }
  return { names: out, cut };
}

/** The scheme name normalised, prefixed `c_` when it does not start with a letter (uncut). */
export function credentialName(scheme: string): string {
  const n = normaliseName(scheme);
  return /^[a-z]/.test(n) ? n : `c_${n}`;
}

/** The env var for a credential name: upper-cased, prefixed `API_` when that would be reserved. */
export function credentialEnv(name: string): string {
  const env = name.toUpperCase();
  return isReservedEnv(env) ? `API_${env}` : env;
}

/**
 * The final names for one scheme: `base` cut so every `<base><_N><suffix>` is at most
 * {@link MAX_CREDENTIAL_NAME} characters, with the smallest `_N` (none, then `_2`, `_3`, …) for
 * which no name and no env var is already taken.
 */
export function fitCredentialNames(
  base: string,
  suffixes: readonly string[],
  takenNames: ReadonlySet<string>,
  takenEnvs: ReadonlySet<string>,
): readonly string[] {
  const longest = Math.max(...suffixes.map((s) => s.length));
  for (let n = 1; ; n++) {
    const tag = n === 1 ? "" : `_${n}`;
    const stem = `${trimUnderscores(base.slice(0, MAX_CREDENTIAL_NAME - longest - tag.length), false)}${tag}`;
    const names = suffixes.map((s) => `${stem}${s}`);
    if (names.every((x) => !takenNames.has(x) && !takenEnvs.has(credentialEnv(x)))) return names;
  }
}

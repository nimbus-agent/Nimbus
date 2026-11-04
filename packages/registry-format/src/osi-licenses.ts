import { isOperator, readManifestLicense, tokenise } from "./author-metadata.ts";

/** OSI-approved SPDX license ids. Lookup is case-sensitive, as SPDX ids are. */
export const OSI_LICENSE_IDS: ReadonlySet<string> = new Set(
  (
    "0BSD AFL-3.0 AGPL-3.0 AGPL-3.0-only AGPL-3.0-or-later Apache-2.0 Artistic-2.0 BlueOak-1.0.0 " +
    "BSD-2-Clause BSD-3-Clause BSL-1.0 CDDL-1.0 CECILL-2.1 ECL-2.0 EPL-1.0 EPL-2.0 EUPL-1.2 " +
    "GPL-2.0 GPL-2.0-only GPL-2.0-or-later GPL-3.0 GPL-3.0-only GPL-3.0-or-later ISC LGPL-2.1 " +
    "LGPL-2.1-only LGPL-2.1-or-later LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later MIT MIT-0 MPL-2.0 " +
    "MS-PL MS-RL NCSA OFL-1.1 OSL-3.0 PostgreSQL Python-2.0 UPL-1.0 Unlicense Zlib"
  ).split(" "),
);

/**
 * Ids in a VALID expression (as `readManifestLicense` accepts) that are not OSI-listed.
 * Exception ids after WITH are ignored; a trailing `+` is stripped before lookup.
 * An invalid expression yields no ids.
 */
export function nonOsiLicenseIds(expr: string): string[] {
  if (readManifestLicense({ license: expr }).kind !== "ok") return [];
  const out: string[] = [];
  const tokens = tokenise(expr);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (t === "(" || t === ")") continue;
    if (t === "WITH") {
      i++;
      continue;
    }
    if (isOperator(t)) continue;
    const bare = t.endsWith("+") ? t.slice(0, -1) : t;
    if (!OSI_LICENSE_IDS.has(bare) && !out.includes(t)) out.push(t);
  }
  return out;
}

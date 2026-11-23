import { bindingSitesOf } from "./binding-sites.ts";
import {
  arrowFunctionsOf,
  declarationsOf,
  destructuringsOf,
  type FileIndex,
  forOfLoopsOf,
  functionDeclarationsOf,
  namedImportsOf,
} from "./file-index.ts";
import type { Prepared } from "./lexical.ts";

export function indexFile(p: Prepared): FileIndex {
  const s = p.blank;
  const imports: Array<readonly [number, number]> = [];
  for (const m of s.matchAll(/\bimport\b[^;]*?\bfrom\b/g)) {
    imports.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  const fns = [...functionDeclarationsOf(s), ...arrowFunctionsOf(s)];
  const namedImports = namedImportsOf(p, imports);
  return {
    declarations: declarationsOf(s),
    destructurings: destructuringsOf(s),
    fns,
    loops: forOfLoopsOf(s),
    bindings: bindingSitesOf(s, fns, namedImports, imports),
    imports,
    namedImports,
  };
}

/** What may stand between `import` and its `{ ... }` clause: `type`, or a default binding and comma. */

import { Analysis } from "./analysis-checks.ts";
import type { File, State } from "./analysis-state.ts";
import { indexFile } from "./index-file.ts";
import { isBalanced, prepare } from "./lexical.ts";
import { fingerprint } from "./module-shapes.ts";
import {
  type PackageSource,
  ROOT_REGISTRAR_FACTORY,
  type WriteToolScan,
} from "./package-sources.ts";

/**
 * Derive every write-tool registration in `sources`. Discovery runs to a fixpoint (a forwarder
 * found in one pass makes its call sites registrations in the next); the result and every
 * violation come from the final, converged pass.
 */
export function scanWriteToolRegistrations(sources: readonly PackageSource[]): WriteToolScan {
  const files: File[] = sources.map((src) => {
    const p = prepare(src);
    return { p, ix: indexFile(p) };
  });
  const state: State = {
    factories: new Map([[ROOT_REGISTRAR_FACTORY, "root"]]),
    keys: new Set(),
    locals: new Map(),
    exported: new Map(),
  };
  for (let pass = 0; pass < 25; pass++) {
    const before = fingerprint(state);
    const analysis = new Analysis(state, files);
    for (const f of files) analysis.discoverBindings(f);
    for (const f of files) analysis.scanCalls(f);
    if (fingerprint(state) !== before) continue;
    for (const f of files) {
      if (!isBalanced(f.p.blank)) {
        analysis.violation(
          f,
          0,
          "brackets do not balance after stripping — the scan lost its place",
        );
      }
      analysis.checkEscapes(f);
      analysis.checkMutates(f);
      analysis.checkModuleShapes(f);
    }
    analysis.checkNamed();
    return { registrations: analysis.registrations, violations: analysis.violations };
  }
  return {
    registrations: [],
    violations: [{ file: "(package)", line: 0, reason: "registrar discovery did not converge" }],
  };
}

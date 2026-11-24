// D46(h) (owner ruling 9, `nimbus incident investigate --live`, invariant I57 (a) extension): the live read of an
// investigation lives in ONE module outside `incident/`, so incident assembly stays read-only over the index.
// Rule ids, over the non-test files of `packages/gateway/src/`, comments stripped:
//   `investigate-read-type-confined`: the identifier `investigateReadActionType` only in `engine/investigate-read.ts`
//       (its definition) and `investigation/investigation-live.ts` (its one caller), and the text
//       `.investigate.read` only in `engine/investigate-read.ts`, so no other module can build an action the
//       dispatcher treats as an investigation read;
//   `investigate-live-confined`: the identifiers `createLiveInvestigator` and `investigationLive` only where the
//       live path is wired (`investigation/investigation-live.ts`, `platform/assemble.ts`, `ipc/server/options.ts`,
//       `ipc/server/dispatchers/ops-rpcs.ts`, `ipc/investigation-rpc.ts`), so a schedule, the model, an outside
//       agent, ChatOps or a sync pass cannot reach the reader;
//   `incident-live-import`: no file under `incident/` and no `agents/_lib/incident*.ts` names the module path
//       `investigation-live` (the D46(a) scope stays inert: no executor, no connector call);
//   `investigate-live-forbidden-import` / `investigate-live-no-network`: the live module imports nothing from
//       `chatops/`, `egress/`, `federation/` or `share/` (its reads reach the wire only through the executor's
//       dispatcher, whose I29 row it cannot skip), imports `connectors/` only for the two pure helpers it needs
//       (`before-select.ts`, `tool-map.ts`), and uses no network primitive.
// Stated bounds: a text scan, so a dynamically composed name or type evades it (the dispatcher lets an
// investigation read resolve only to a read of its own service, and `ipc/investigation-rpc.ts` refuses every
// connection that did not declare `cli`: those are the other half, pinned in
// `security-invariants/i57-incident-engine.test.ts`).
import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { checkConfinement, D45_FORBIDDEN_SEGMENT_RE } from "./extension-grants-eval.ts";

const SRC = "packages/gateway/src/";
const LIVE = `${SRC}investigation/investigation-live.ts`;
const READ_TYPE = `${SRC}engine/investigate-read.ts`;
const WIRING: readonly string[] = [
  LIVE,
  `${SRC}platform/assemble.ts`,
  `${SRC}ipc/server/options.ts`,
  `${SRC}ipc/server/dispatchers/ops-rpcs.ts`,
  `${SRC}ipc/investigation-rpc.ts`,
];
const TYPE_RE = /\binvestigateReadActionType\b/g;
const SUFFIX_RE = /\.investigate\.read\b/g;
const WIRING_RE = /\b(?:createLiveInvestigator|investigationLive)\b/g;
// A literal property access (`ns["createLiveInvestigator"]`) keeps its name inside a string, which the
// string-stripped scan blanks, so it is matched on the comment-free text.
const BRACKET_RE =
  /\[\s*["'`](?:investigateReadActionType|createLiveInvestigator|investigationLive)["'`]\s*\]/g;
const INCIDENT_IMPORT_RE = /investigation-live/g;
const ALLOWED_CONNECTOR_IMPORT_RE =
  /connectors\/(?:connector-writes\/before-select|lazy-mesh\/tool-map)\.ts$/;

const inIncidentScope = (relPath: string): boolean =>
  relPath.startsWith(`${SRC}incident/`) ||
  /^packages\/gateway\/src\/agents\/_lib\/incident[\w.-]*\.ts$/.test(relPath);

export function checkInvestigateLiveConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath) || !f.relPath.startsWith(SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== READ_TYPE) {
      for (const m of commentFree.matchAll(SUFFIX_RE)) {
        add("investigate-read-type-confined", f, commentFree, m.index);
      }
      if (f.relPath !== LIVE) {
        for (const m of code.matchAll(TYPE_RE))
          add("investigate-read-type-confined", f, code, m.index);
      }
    }
    if (f.relPath !== LIVE) {
      for (const m of commentFree.matchAll(BRACKET_RE)) {
        add("investigate-live-confined", f, commentFree, m.index);
      }
    }
    if (!WIRING.includes(f.relPath)) {
      for (const m of code.matchAll(WIRING_RE)) add("investigate-live-confined", f, code, m.index);
    }
    if (inIncidentScope(f.relPath)) {
      for (const m of commentFree.matchAll(INCIDENT_IMPORT_RE)) {
        add("incident-live-import", f, commentFree, m.index);
      }
    }
  }
  out.push(
    ...checkConfinement(files, {
      inScope: (relPath) => relPath === LIVE,
      forbiddenSegmentRe: D45_FORBIDDEN_SEGMENT_RE,
      forbiddenImportRule: "investigate-live-forbidden-import",
      noNetworkRule: "investigate-live-no-network",
      allowTarget: (target) => ALLOWED_CONNECTOR_IMPORT_RE.test(target),
    }),
  );
  return out;
}

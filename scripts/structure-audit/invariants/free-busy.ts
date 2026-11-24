// Static rule D13(b) (I17 (b), Phase 10 OR-S4-SCHED): federated free/busy answering is confined. It extends D13
// (federated answering is confined to its gate) under the same number: no new rule number.
//   (a) `free-busy-read-confined`: the module that reads calendar events (`federation/_lib/free-busy-read.ts`)
//       is imported only by the gate (`federation/free-busy-gate.ts`) and the asking side
//       (`federation/schedule-ask.ts`), so no other code can build a peer-facing answer from calendar rows.
//   (b) `free-busy-gate-confined`: `answerFederatedFreeBusy` is named only by the gate and by the LAN
//       server (`federation/federation-server.ts`), the one place that serves `federation.freeBusy`.
//   (c) `free-busy-forbidden-field`: the three files that read and shape the answer
//       (`_lib/free-busy-read.ts`, `_lib/free-busy-blocks.ts`, `free-busy-gate.ts`) name none of the event
//       fields a peer must never learn (title, attendees, organiser, location, url, body, description,
//       summary, calendar name, id), in code or in a SQL string; comments are exempt.
// Stated bounds: a text scan; a field named through a computed key is not seen, which is why the
// runtime leak tests in `security-invariants/i17-free-busy.test.ts` are the other half.

import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

const FB_DIR = "packages/gateway/src/federation/";
const READER = `${FB_DIR}_lib/free-busy-read.ts`;
const GATE = `${FB_DIR}free-busy-gate.ts`;
const ASK = `${FB_DIR}schedule-ask.ts`;
const SERVER = `${FB_DIR}federation-server.ts`;
const SHAPING = [READER, `${FB_DIR}_lib/free-busy-blocks.ts`, GATE];
const READER_IMPORT_RE = /from\s+["'][^"']*free-busy-read(?:\.ts)?["']/g;
const GATE_NAME_RE = /\banswerFederatedFreeBusy\b/;
// A forbidden field name, or an event-id access: `.id`, `["id"]`, or a destructuring that names `id`.
// A bare `id` (a loop variable, a lookup argument, an ORDER BY column) stays allowed.
const FIELD_RE =
  /\b(?:title|attendees?|attendee_count|organi[sz]er(?:_email)?|location|url|body|body_preview|description|summary|calendar_name|external_id|author_id)\b|\.id\b|\[\s*["']id["']\s*\]|\{[^{}]*\bid\b[^{}]*\}\s*=(?!=)/;

function scan(f: FileEntry, re: RegExp, rule: string, out: Violation[]): void {
  const original = f.contents.split("\n");
  const stripped = stripComments(f.contents);
  if (re.global) {
    // Match the whole comment-stripped source, so a statement split over lines is still seen; the
    // line comes from the match offset.
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
    return;
  }
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i] ?? "")) {
      out.push({ rule, file: f.relPath, line: i + 1, snippet: (original[i] ?? "").trim() });
    }
  }
}

export function checkFreeBusyConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (![READER, GATE, ASK].includes(f.relPath)) {
      scan(f, READER_IMPORT_RE, "free-busy-read-confined", out);
    }
    if (![GATE, SERVER].includes(f.relPath)) {
      scan(f, GATE_NAME_RE, "free-busy-gate-confined", out);
    }
    if (SHAPING.includes(f.relPath)) scan(f, FIELD_RE, "free-busy-forbidden-field", out);
  }
  return out;
}

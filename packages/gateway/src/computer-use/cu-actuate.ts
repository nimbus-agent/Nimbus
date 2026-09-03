import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CuLaneHandle } from "./cu-types.ts";

export interface ActuationRequest {
  readonly kind:
    | "click"
    | "type"
    | "navigate"
    | "read"
    | "screenshot"
    | "download"
    | "terminal_write";
  readonly selector?: string;
  readonly text?: string;
  readonly url?: string;
}

/**
 * The SINGLE actuation primitive — the home of invariant I35 / static rule D26(a).
 *
 * Callable only from `cu-gate.ts` plus this definition file, enforced both statically
 * (`check-nimbus-invariants.ts`'s `checkActuationConfinement`) and at runtime
 * (`security-invariants.test.ts`'s `describe("I35 — …")`), landed together in Task 13. A second
 * caller would be a second path from a model-proposed action to the host, bypassing the envelope
 * check, the structural classifier, the consent round-trip and the audit-log append the gate makes
 * around every call here. Mirrors D23's `runConfined` confinement exactly.
 */
export async function performActuation(
  lane: CuLaneHandle,
  req: ActuationRequest,
): Promise<string | null> {
  if (lane.kind === "terminal") {
    if (req.kind !== "terminal_write") {
      // Fail closed rather than fall through. A browser kind reaching a terminal handle means the
      // gate's own lane/kind agreement check did not run — refusing here keeps a second, silent
      // path from existing at all.
      throw new Error(`ERR_CU_LANE_KIND_MISMATCH: ${req.kind} is not a terminal action`);
    }
    const r = await lane.terminal.write(req.text ?? "");
    // The result crosses back as TEXT and is wrapped by `cu-tools.ts` (I11) before any model sees
    // it. The `settled` disclosure travels WITH the output rather than beside it, so a reader
    // cannot mistake "we stopped waiting" for "the command finished".
    //
    // `quiet` is the ONLY silent case: output arrived and then stopped, which is what "it finished"
    // looks like from here. Every other ending is disclosed, INCLUDING `no_output` — a command that
    // printed nothing within the first-byte window may have finished silently or may still be
    // running, and saying "it produced no output" without saying which would assert the one thing
    // this driver cannot know.
    if (r.settled === "quiet") return r.output;
    const truncatedNote = r.truncated ? ", truncated" : "";
    return `${r.output}\n[nimbus: output collection ended by ${r.settled}${truncatedNote}]`;
  }

  if (req.kind === "terminal_write") {
    throw new Error("ERR_CU_LANE_KIND_MISMATCH: terminal_write is not a browser action");
  }

  const browser = lane.browser;
  switch (req.kind) {
    case "click":
      await browser.click(req.selector ?? "");
      return null;
    case "type":
      await browser.type(req.selector ?? "", req.text ?? "");
      return null;
    case "navigate":
      await browser.navigate(req.url ?? "");
      return null;
    case "read":
      return await browser.readText();
    case "screenshot": {
      // Digest ONLY, per spec § 7: screenshot PIXELS are never held any longer than this
      // expression and never written to disk. Only the BLAKE3 digest crosses back to the caller,
      // for the `cu_action.screenshot_digest` column — the plan's own verbatim code for this
      // branch discarded the captured bytes entirely (`await lane.screenshot(); return null;`)
      // despite its own comment claiming they were "returned in memory to the caller", which
      // would have left that column permanently NULL for every browser-lane screenshot. Fixed
      // here rather than reproduced, the same way earlier tasks' implementers fixed a verbatim
      // defect they found (see the plan ledger's R23).
      const bytes = await browser.screenshot();
      return bytesToHex(blake3(bytes));
    }
    case "download":
      // No lane implements a download (`BrowserLane` declares no download method, and the driver
      // denies downloads at the BROWSER level via `Browser.setDownloadBehavior`, so there is
      // nothing for one to hook into). Returning `null` here did no work but still let `cu-gate.ts`
      // record `outcome: "actuated"` / `hitl_status: "approved"`: an owner-approved "download"
      // action would have been recorded as a SUCCESSFUL actuation that actually downloaded
      // nothing. Fail closed instead — the throw is caught by `cu-gate.ts`'s existing
      // `performActuation` try/catch and correctly recorded as `failed_after_approval`, which is
      // the honest outcome: the owner said yes, and nothing capable of doing it existed.
      throw new Error("ERR_CU_UNSUPPORTED_ACTION: download is not implemented");
    default: {
      // Exhaustiveness (ruling D / I29's ClientKind precedent): an action kind this function was
      // never told to handle is a COMPILE ERROR here, not a silent fall-through.
      const exhaustive: never = req.kind;
      throw new Error(`unrecognised action kind: ${String(exhaustive)}`);
    }
  }
}

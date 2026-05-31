import type { HitlRequest } from "@nimbus-dev/client";

import type { WindowApi } from "../vscode-shim.js";
import type { HitlDecision } from "./hitl-router.js";

export function createToastSurface(window: WindowApi) {
  return async (req: HitlRequest): Promise<HitlDecision | undefined> => {
    const answer = await window.showInformationMessage(
      `Nimbus consent: ${req.prompt}`,
      {},
      "Approve",
      "Reject",
      "View Details",
    );
    if (answer === "Approve") return "approve";
    if (answer === "Reject") return "reject";
    if (answer === "View Details") {
      return undefined;
    }
    return undefined;
  };
}

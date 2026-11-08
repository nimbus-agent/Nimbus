// D1c Task 9: the two commit rows' free text is shown in FULL and deliberately NOT scanned.
//  - `files[].content` is CODE, not Markdown: an image tag, a link, `@here` or a line starting with
//    `/` is ordinary text there, and scanning it as Markdown would refuse real source files. The
//    owner reads the whole diff (and a credential or a bidi control is refused by `commit-paths.ts`).
//  - `message` is the commit message: shown in full. Whether a platform notifies on a mention in a
//    commit message is NOT verified (plan open question 6); the bound is recorded in
//    docs/SECURITY-INVARIANTS.md and the roadmap, and `message` joins the broadcast table only if a
//    live check shows it.
// These tests fail if either key is added to any scan table by accident (a decision, not a drift).
import { describe, expect, test } from "bun:test";
import type { ChatopsPolicy } from "../../policy/types.ts";
import {
  actDoorRefusal,
  modelWriteRefusal,
  nullRefusedOptionalKeys,
  quickActionTextKeys,
  remoteContentScannedKeys,
  remoteContentScannedRows,
  scannedTextKeys,
  scopedLabelKeys,
} from "./model-write-refusals.ts";

const COMMITS = ["github_file_commit", "gitlab_commit_create"] as const;
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

describe("commit free text is shown in full and not scanned", () => {
  test("neither `files` nor `message` is in any scan table, for either row", () => {
    for (const id of COMMITS) {
      expect(remoteContentScannedRows(), id).not.toContain(id);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(quickActionTextKeys(id), id).toEqual([]);
      expect(scopedLabelKeys(id), id).toEqual([]);
      expect(nullRefusedOptionalKeys(id), id).toEqual([]);
    }
  });

  test("code that would be refused as Markdown or chat text passes in a file and in the message", () => {
    const code = [
      '<img src="https://example.invalid/pixel.png">',
      "[![badge](https://example.invalid/b.svg)](https://example.invalid)",
      "@here @channel @all <!here>",
      "/close",
      "/assign @someone",
      '<link rel="stylesheet" href="https://example.invalid/a.css">',
    ].join("\n");
    for (const id of COMMITS) {
      const input = {
        message: "Fixes #1 @all /close",
        files: [{ path: "docs/page.html", content: code }],
      };
      expect(
        modelWriteRefusal(id, input, { chatops: NO_CHATOPS, kb: undefined }),
        id,
      ).toBeUndefined();
    }
  });

  test("the act door never proposes a commit, so its refusal check is not the control there", () => {
    // The act door's check is the shared messaging check; for a commit it returns undefined, and the
    // row is not proposable at all (proposable-actions.test.ts).
    for (const id of COMMITS) {
      const ctx = { chatops: NO_CHATOPS, kb: undefined, kbUnreadable: false };
      expect(actDoorRefusal(id, { message: "m", files: [] }, ctx), id).toBeUndefined();
    }
  });
});

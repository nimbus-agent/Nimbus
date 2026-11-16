// B3 review fix 2: a KB configured at boot is refused on the MCP act door. `assemble.ts` loads
// `[tribal]` once, BEFORE the capture gate, and hands the act door the same accessor as
// `platform.tribalKbConfig` (pinned in security-invariants.test.ts, I28 block); this proves that
// composition (the real loader, the real `tribalKbConfigOf`, the door's refusal) refuses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadNimbusTribalFromConfigDir,
  nimbusTribalConfigUnreadable,
} from "../config/nimbus-toml.ts";
import {
  KNOWLEDGE_BASE_REFUSAL,
  KNOWLEDGE_BASE_UNREADABLE_REFUSAL,
} from "../connectors/connector-writes/model-write-refusals.ts";
import { createActionDestinationRefusal } from "../ipc/approved-door.test-helpers.ts";
import { tribalKbConfigOf } from "./assemble.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bootRefusal(toml: string | undefined, unreadableLayer = false) {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-act-door-kb-"));
  dirs.push(dir);
  // A config path that exists but cannot be read as a file (a directory) is an UNREADABLE layer.
  if (unreadableLayer) mkdirSync(join(dir, "nimbus.toml"));
  else if (toml !== undefined) writeFileSync(join(dir, "nimbus.toml"), toml, "utf8");
  const tribalCfg = loadNimbusTribalFromConfigDir(dir);
  const unreadable = nimbusTribalConfigUnreadable(dir);
  expect(unreadable).toBe(unreadableLayer);
  return createActionDestinationRefusal(
    () => undefined,
    () => tribalKbConfigOf(tribalCfg, unreadable),
  );
}

const KB_TOML =
  '[tribal.confluence]\nspace_key = "KB"\nparent_page_id = "4242"\n' +
  '[tribal.notion]\ndatabase_id = "0123abcd0123abcd0123abcd0123abcd"\n';

describe("a KB configured at boot reaches the act door (B3, review fix 2)", () => {
  test("a page write to the KB destination is refused; a page update elsewhere is left to the executor's before-state guard", () => {
    const refusal = bootRefusal(KB_TOML);
    expect(
      refusal("confluence.page.update", {
        pageId: "4242",
        versionNumber: 1,
        title: "t",
        storageHtml: "x",
      }),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
    expect(refusal("notion.page.update", { pageId: "ffff", propertiesJson: "{}" })).toBeUndefined();
  });

  test("an UNREADABLE config layer is not an absent KB: every KB-capable page write is refused", () => {
    const refusal = bootRefusal(undefined, true);
    expect(refusal("notion.page.update", { pageId: "ffff", propertiesJson: "{}" })).toBe(
      KNOWLEDGE_BASE_UNREADABLE_REFUSAL,
    );
    expect(
      refusal("confluence.page.update", {
        pageId: "9",
        versionNumber: 1,
        title: "t",
        storageHtml: "x",
      }),
    ).toBe(KNOWLEDGE_BASE_UNREADABLE_REFUSAL);
  });

  test("with no [tribal] KB the same proposals are not refused", () => {
    const refusal = bootRefusal(undefined);
    expect(
      refusal("confluence.page.update", {
        pageId: "4242",
        versionNumber: 1,
        title: "t",
        storageHtml: "x",
      }),
    ).toBeUndefined();
    expect(refusal("notion.page.update", { pageId: "ffff", propertiesJson: "{}" })).toBeUndefined();
  });
});

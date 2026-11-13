// B3 review fix 2: a KB configured at boot is refused on the MCP act door. `assemble.ts` loads
// `[tribal]` once, BEFORE the capture gate, and hands the act door the same accessor as
// `platform.tribalKbConfig` (pinned in security-invariants.test.ts, I28 block); this proves that
// composition (the real loader, the real `tribalKbConfigOf`, the real act-door refusal) refuses.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNimbusTribalFromConfigDir } from "../config/nimbus-toml.ts";
import {
  ACT_DOOR_KB_CHILD_REFUSAL,
  KNOWLEDGE_BASE_REFUSAL,
} from "../connectors/connector-writes/model-write-refusals.ts";
import { createActionDestinationRefusal } from "../ipc/legacy-refusal.test-helpers.ts";
import { tribalKbConfigOf } from "./assemble.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bootRefusal(toml: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-act-door-kb-"));
  dirs.push(dir);
  if (toml !== undefined) writeFileSync(join(dir, "nimbus.toml"), toml, "utf8");
  const tribalCfg = loadNimbusTribalFromConfigDir(dir);
  return createActionDestinationRefusal(
    () => undefined,
    () => tribalKbConfigOf(tribalCfg),
  );
}

const KB_TOML =
  '[tribal.confluence]\nspace_key = "KB"\nparent_page_id = "4242"\n' +
  '[tribal.notion]\ndatabase_id = "0123abcd0123abcd0123abcd0123abcd"\n';

describe("a KB configured at boot reaches the act door (B3, review fix 2)", () => {
  test("a page write to the KB destination, and a page update while a KB is configured, are refused", () => {
    const refusal = bootRefusal(KB_TOML);
    expect(
      refusal("confluence.page.update", {
        pageId: "4242",
        versionNumber: 1,
        title: "t",
        storageHtml: "x",
      }),
    ).toBe(KNOWLEDGE_BASE_REFUSAL);
    expect(refusal("notion.page.update", { pageId: "ffff", propertiesJson: "{}" })).toBe(
      ACT_DOOR_KB_CHILD_REFUSAL,
    );
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

// The docs site's Agent kits page restates what the kits do. This test holds it to the code: the
// steer table, the owner commands, the "not a boundary" line and the "outside the door" paragraph.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { KIT_IDS } from "../../packages/cli/src/agent-kits/kit-types.ts";
import { OWNER_COMMANDS, STEER_ROWS } from "../../packages/cli/src/agent-kits/steer-table.ts";
import { NOT_A_BOUNDARY, OUTSIDE_THE_DOOR } from "../../packages/cli/src/commands/agent.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PAGE = readFileSync(
  join(ROOT, "packages/docs/src/content/docs/user-guide/agent-kits.mdx"),
  "utf8",
).replaceAll(/\s+/g, " ");

describe("the Agent kits page", () => {
  test("opens what an agent can still do outside the door with the self-approval sentence, verbatim", () => {
    expect(PAGE).toContain(OUTSIDE_THE_DOOR);
    expect(OUTSIDE_THE_DOOR.indexOf("can still approve its own proposals")).toBeLessThan(
      OUTSIDE_THE_DOOR.indexOf("credentials already on this machine"),
    );
  });

  test("says steering is not a security boundary, in the command's own words", () => {
    expect(PAGE).toContain(`**${NOT_A_BOUNDARY}**`);
  });

  test("lists exactly the steer table's rows and the three owner commands", () => {
    for (const row of STEER_ROWS) {
      expect(PAGE).toContain(
        `| \`${row.argv.join(" ")}\` | \`propose_action\` with type \`${row.actionType}\` |`,
      );
    }
    expect(PAGE.split("| `propose_action` with type `").length - 1).toBe(STEER_ROWS.length);
    for (const command of OWNER_COMMANDS) expect(PAGE).toContain(`\`${command.join(" ")}\``);
  });

  test("has a section and a matrix row for every kit, and no row is filled without a run", () => {
    const titles: Record<(typeof KIT_IDS)[number], string> = {
      "claude-code": "Claude Code",
      codex: "Codex",
      cursor: "Cursor",
      vscode: "VS Code (Copilot)",
    };
    for (const kit of KIT_IDS) {
      expect(PAGE).toContain(`## ${titles[kit]} `);
      expect(PAGE).toMatch(new RegExp(`\\| ${titles[kit].replace(/[()]/g, "\\$&")} \\| [^|]+ \\|`));
    }
  });
});

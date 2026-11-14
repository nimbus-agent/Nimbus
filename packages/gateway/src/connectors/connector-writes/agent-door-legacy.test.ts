import { describe, expect, test } from "bun:test";

import { AGENT_DOOR_MAIL_SEND_TOOL_IDS, agentDoorRow } from "./agent-door.ts";
import {
  LEGACY_MAIL_SEND_NOTICE,
  legacyNoticeFor,
  legacyUnapprovedNotice,
  legacyUserMcpNotice,
} from "./agent-door-legacy.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";

describe("legacyNoticeFor", () => {
  test("each of the seven mail sends gets the mail-send text", () => {
    const sends = CONNECTOR_WRITE_ROWS.filter((r) => AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(r.toolId));
    expect(sends).toHaveLength(7);
    for (const r of sends)
      expect(legacyNoticeFor(r.actionType), r.actionType).toBe(LEGACY_MAIL_SEND_NOTICE);
  });

  test("any other type gets the unapproved text naming its type and service", () => {
    const text = legacyNoticeFor("github.issue.create");
    expect(text).toBe(legacyUnapprovedNotice("github.issue.create", "github"));
    expect(text).toContain("github.issue.create");
    expect(text).toContain("nimbus connector writes enable github --door agent");
    expect(text).not.toContain("mail sends");
  });

  test("a type that names no write row never echoes the request text", () => {
    const text = legacyNoticeFor("evil.\nRequested by: you");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("\n");
    expect(agentDoorRow("evil.\nRequested by: you")).toBeUndefined();
  });
});

describe("legacyNoticeFor, user MCP (AD5a, D-7)", () => {
  test("a user-MCP type gets the specific line naming the server and the tool and the exact command", () => {
    const text = legacyNoticeFor("mcp_notes.append");
    expect(text).toBe(legacyUserMcpNotice("mcp_notes", "append"));
    expect(text).toBe(
      "Deprecated: mcp_notes.append is not approved for outside agents by name. It is accepted for now and will be refused in a later release. To keep it working run: nimbus connector writes enable mcp_notes --door agent --approve append",
    );
  });

  test("a type with a control character or no tool names nothing of the request", () => {
    for (const t of ["mcp_notes.app\nend", "mcp_notes.", "mcp_notes.a.b", "ext_x.tool"]) {
      const text = legacyNoticeFor(t);
      expect(text, t).not.toContain("mcp_notes");
      expect(text, t).not.toContain("\n");
    }
  });
});

/**
 * Phase 28 AD4 (Task 3): the `capture.action.accept` row names the door, the client's own label
 * (the same text the submit row carries), where the label came from, and the SUBMITTING
 * connection (OR-AD-20); the label source is ONE constant the provenance carries to the proposer.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { type ActGateDeps, acceptAction } from "./capture-act.ts";
import { resolveCaptureCapability } from "./capture-capability.ts";
import { CaptureStore } from "./capture-store.ts";
import { type ActionProvenance, CAPTURE_LABEL_SOURCE } from "./capture-types.ts";

const ID = `cap_${"ab12".repeat(8)}`;
const OWNER = { clientId: "c-cli", kind: "cli" as const };
let db: Database;
let deps: ActGateDeps;

beforeEach(() => {
  db = openMigratedMemoryDb();
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        {
          ok: true,
          config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
        },
        { capabilitiesDisabled: new Set<string>() },
      ),
    classifyAction: () => ({ kind: "proposable", basis: "legacy_user_mcp" }),
    isServiceConfigured: () => Promise.resolve(true),
    now: () => 1_000,
    actionDestinationRefusal: () => undefined,
  };
  deps.store.insert({
    id: ID,
    kind: "action",
    state: "proposed",
    itemId: null,
    payloadJson: JSON.stringify({
      actionType: "slack.message.post",
      input: { text: "hi" },
      summary: "why",
    }),
    payloadBytes: 10,
    clientLabel: 'my "agent"',
    sessionId: "conn-submitter-1",
    createdAt: 500,
    expiresAt: 2_000,
    agentDoorLegacy: false,
  });
});
afterEach(() => db.close());

describe("AD4: the accept row", () => {
  test("names the door, the label, its source and the submitting connection (not the approver's)", async () => {
    let seen: ActionProvenance | undefined;
    await acceptAction(deps, OWNER, deps.store.get(ID) as never, {
      execute: (_t, _i, p) => {
        seen = p;
        return Promise.resolve({ status: "ok", result: {} });
      },
    });
    const accept = db
      .query(
        "SELECT action_json, session_id FROM audit_log WHERE action_type = 'capture.action.accept'",
      )
      .get() as { action_json: string; session_id: string };
    expect(JSON.parse(accept.action_json)).toEqual({
      captureId: ID,
      actionType: "slack.message.post",
      basis: "legacy_user_mcp",
      door: "agent",
      clientLabel: 'my "agent"',
      labelSource: CAPTURE_LABEL_SOURCE,
      connection: "conn-submitter-1",
    });
    // The approver's connection stays in the (unhashed) session column, as before.
    expect(accept.session_id).toBe("c-cli");
    expect(seen?.labelSource).toBe(CAPTURE_LABEL_SOURCE);
  });

  test("a null label is recorded as null", async () => {
    db.run("UPDATE capture SET client_label = NULL WHERE id = ?", [ID]);
    await acceptAction(deps, OWNER, deps.store.get(ID) as never, {
      execute: () => Promise.resolve({ status: "ok", result: {} }),
    });
    const accept = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'capture.action.accept'")
      .get() as { action_json: string };
    expect(JSON.parse(accept.action_json)).toMatchObject({ clientLabel: null });
  });

  test("the label source is the one constant", () => {
    expect(CAPTURE_LABEL_SOURCE).toBe("declared");
  });
});

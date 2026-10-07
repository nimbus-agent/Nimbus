import { isConnectorCodeExecutionToolId } from "../connectors/connector-code-execution-tool-ids.ts";
import { isUserMcpToolKey } from "../connectors/user-mcp-store.ts";

/**
 * Positive read-only tool allowlist for recipe replay (Phase 6 Slice 8c, spec §8.1).
 *
 * A tool is read-only iff its trailing `_`-segment is a recognized READ verb. The set is the
 * spec's four (`list`/`get`/`query`/`search`) plus a curated read surface grounded in a scan of
 * the first-party connectors' tool ids — then `packages/mcp-connectors/*`, now the
 * `@nimbus-dev/connectors` package built from nimbus-agent/nimbus-mcp-servers (e.g.
 * `slack_channel_history`, `gdrive_file_metadata`, `*_read`/`*_fetch`/`*_download`). This is
 * intentionally a POSITIVE allowlist — a write tool absent from `HITL_REQUIRED_BACKING` (a real
 * risk the design review flagged) is STILL classified non-read here, because classification never
 * consults the HITL set. Anything unrecognized is skipped (`skipped-non-read`), which is fail-safe:
 * a missed read tool costs replay coverage, never safety. Broadening the set is a safe, additive
 * follow-up.
 *
 * A code-execution tool id (I26 `isConnectorCodeExecutionToolId`) is EXCLUDED whatever its verb,
 * because `share.replay` is a second door a caller names tools through (an untrusted share file,
 * which can arrive via `federation.shareForward`) and runs them against the owner's own credentialed
 * mesh. Dropping the `preview` verb closed that door for `iac_pulumi_preview`, but the `az`/`gcloud`
 * reads end in `list`/`get`/`search` — verbs hundreds of genuine reads carry, so they cannot be
 * dropped. Those reads reach a `.cmd` wrapper's argv on Windows, where a share-supplied value
 * injects a command, so they must be unreplayable by explicit id, exactly as the federated gate
 * refuses them. Kept in step by `connector-code-execution-sync.test.ts`.
 *
 * A user-registered MCP server's tool key (`mcp_<id>_<tool>`) is EXCLUDED likewise (invariant I42):
 * every call to one needs the LOCAL owner's approval, while replay runs tools with no consent at
 * all, from a file a third party may have supplied — and the verbs of an owner-registered server
 * mean whatever that server says they mean.
 */
const READ_VERBS: ReadonlySet<string> = new Set([
  // spec §8.1 core
  "list",
  "get",
  "query",
  "search",
  // curated read surface (read-only verbs observed in connector tool ids)
  "read",
  "fetch",
  "download",
  "describe",
  // "preview" — DELIBERATELY ABSENT. It reads as a read verb and is not one: `iac_pulumi_preview`
  // runs `pulumi preview --cwd <caller-supplied workingDirectory>`, and `pulumi preview` EVALUATES
  // the stack program in that directory. Admitting the verb let an untrusted share file reach local
  // code execution through a list named "read-only". It was also the ONLY real connector tool id
  // ending in `_preview` (the `dataprofile_preview` this list once cited is a name the dataprofile
  // no-row-data contract test asserts must THROW), so removing it costs zero replay coverage.
  // The lesson generalizes: this list classifies by NAME, so a verb earns a place only when every
  // tool that can carry it is known to be a read.
  "history",
  "export",
  "view",
  "show",
  "info", // slack_user_info, teams_user_info
  "metadata", // gdrive_file_metadata
]);

/** Classify a tool id as read-only by its trailing `_`-segment verb. Pure; fail-safe on bad input. */
export function isReadOnlyToolId(toolId: string): boolean {
  if (typeof toolId !== "string") return false;
  // A code-execution tool id is never replayable, whatever read verb its name happens to end in.
  if (isConnectorCodeExecutionToolId(toolId)) return false;
  // I42: a user-MCP tool is never replayable — every call to one needs the local owner.
  if (isUserMcpToolKey(toolId)) return false;
  const idx = toolId.lastIndexOf("_");
  if (idx <= 0 || idx === toolId.length - 1) return false; // no prefix, or trailing "_"
  return READ_VERBS.has(toolId.slice(idx + 1));
}

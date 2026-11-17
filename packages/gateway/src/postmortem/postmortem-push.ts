import type { Database } from "bun:sqlite";

import { connectorWriteRowByToolId } from "../connectors/connector-write-registry.ts";
import { beforeReplyJson, stringAt } from "../connectors/connector-writes/before-select.ts";
import {
  modelWriteRefusal,
  type RefusalContext,
} from "../connectors/connector-writes/model-write-refusals.ts";
import { PAGE_PUSH_TOOL_IDS } from "../connectors/connector-writes/page-push-rows.ts";
import type { ActionResult, PlannedAction } from "../engine/types.ts";
import { mintIncidentLink } from "../incident/incident-link-mint.ts";
import {
  PostmortemConvertError,
  splitTitleAndBody,
  toConfluenceStorage,
  toNotionBlocksJson,
} from "./postmortem-convert.ts";

/**
 * The post-mortem push (Phase 10 IC7a, spec § 5.7, D-IC-3): the owner's edited draft becomes a page through
 * the EXISTING `confluence_page_create` row, or `notion_page_create` and then `notion_block_append` (the
 * Notion create sends a title only; the body is its own existing row). Every action goes through the
 * executor's `execute()` as the LOCAL OWNER's own action: no origin, no proposer, no provenance, the
 * incident link (so the audit row and the timeline name the record), the typed preview, the consent gate on
 * the owner's connection, the audit row and the egress row. This module never dispatches and never answers
 * a prompt; a denial writes nothing.
 *
 * Before any prompt: the file is converted (so a bad file refuses before anything is created) and each
 * row's input runs through `modelWriteRefusal` (the tribal-KB destination and, for a body, the
 * remote-content rule, B3r). The Notion append is checked again with the REAL page id before its prompt.
 *
 * Outcomes are values, never thrown, so the CLI can say exactly what happened. `partial` is the one that
 * matters: the Notion page was created and its body was not.
 */

export type PushTarget =
  | { readonly kind: "notion"; readonly parentPageId: string }
  | { readonly kind: "confluence"; readonly spaceKey: string; readonly parentPageId?: string };

export type PushOutcome =
  | { readonly outcome: "pushed"; readonly pageId: string | null }
  | { readonly outcome: "refused"; readonly code: string; readonly reason: string }
  | { readonly outcome: "denied"; readonly reason: string }
  | {
      readonly outcome: "partial";
      readonly code: "ERR_POSTMORTEM_PUSH_PARTIAL";
      readonly pageId: string;
      readonly reason: string;
    }
  | {
      readonly outcome: "unavailable";
      readonly code: "ERR_POSTMORTEM_PUSH_PARTIAL";
      readonly reason: string;
    };

export type PushDeps = {
  readonly db: Database;
  /** The owner's push executor (`buildOwnerPushExecutor`): all a push needs of it is `execute`. */
  readonly executor: { execute(action: PlannedAction): Promise<ActionResult> };
  /** The live tribal-KB destinations the refusals compare against (an absent accessor refuses the push). */
  readonly refusal: RefusalContext;
};

type Row = { readonly toolId: string; readonly actionType: string };

function rowOf(toolId: string): Row {
  const row = connectorWriteRowByToolId(toolId);
  if (row === undefined) throw new Error(`"${toolId}" is not a connector write tool`);
  return { toolId: row.toolId, actionType: row.actionType };
}

const NOTION_PAGE_ID_RE =
  /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const REASON_MAX = 300;

function failureReason(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  // Control and invisible characters out, cut: the text may carry a provider's words.
  const flat = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return flat.length > REASON_MAX ? `${flat.slice(0, REASON_MAX)}…` : flat;
}

function buildAction(
  row: Row,
  input: Record<string, unknown>,
  link: ReturnType<typeof mintIncidentLink>,
): PlannedAction {
  return {
    type: row.actionType,
    incident: link,
    payload: { mcpToolId: row.toolId, input },
  };
}

async function run(
  deps: PushDeps,
  action: PlannedAction,
): Promise<{ ok: true; result: unknown } | { ok: false; reason: string }> {
  try {
    const out = await deps.executor.execute(action);
    if (out.status === "ok") return { ok: true, result: out.result };
    return { ok: false, reason: failureReason(out.reason) };
  } catch (e) {
    return { ok: false, reason: failureReason(e) };
  }
}

function newPageId(result: unknown): string | null {
  try {
    const id = stringAt(beforeReplyJson(result), ["id"]);
    return id !== undefined && NOTION_PAGE_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function confluencePageId(result: unknown): string | null {
  try {
    const id = stringAt(beforeReplyJson(result), ["id"]);
    return id !== undefined && /^\d{1,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function refusedBy(
  deps: PushDeps,
  toolId: string,
  input: Record<string, unknown>,
): PushOutcome | undefined {
  const reason = modelWriteRefusal(toolId, input, deps.refusal);
  return reason === undefined
    ? undefined
    : { outcome: "refused", code: "ERR_POSTMORTEM_PUSH_REFUSED", reason };
}

async function pushConfluence(
  deps: PushDeps,
  target: Extract<PushTarget, { kind: "confluence" }>,
  link: ReturnType<typeof mintIncidentLink>,
  title: string,
  body: string,
): Promise<PushOutcome> {
  const row = rowOf(PAGE_PUSH_TOOL_IDS.confluenceCreate);
  const input: Record<string, unknown> = {
    spaceKey: target.spaceKey,
    title,
    storageHtml: toConfluenceStorage(body),
    ...(target.parentPageId === undefined ? {} : { parentPageId: target.parentPageId }),
  };
  const refused = refusedBy(deps, row.toolId, input);
  if (refused !== undefined) return refused;
  const made = await run(deps, buildAction(row, input, link));
  if (!made.ok) return { outcome: "denied", reason: made.reason };
  return { outcome: "pushed", pageId: confluencePageId(made.result) };
}

async function pushNotion(
  deps: PushDeps,
  target: Extract<PushTarget, { kind: "notion" }>,
  link: ReturnType<typeof mintIncidentLink>,
  title: string,
  body: string,
): Promise<PushOutcome> {
  const create = rowOf(PAGE_PUSH_TOOL_IDS.notionCreate);
  const append = rowOf(PAGE_PUSH_TOOL_IDS.notionAppend);
  const createInput: Record<string, unknown> = { parentPageId: target.parentPageId, title };
  // Convert BOTH bodies and check BOTH rows before anything is created. The append's real page id is not
  // known yet, so the first check names the parent (it exercises the body and the KB-destination rules).
  const childrenJson = toNotionBlocksJson(body);
  const early =
    refusedBy(deps, create.toolId, createInput) ??
    refusedBy(deps, append.toolId, { parentBlockId: target.parentPageId, childrenJson });
  if (early !== undefined) return early;

  const made = await run(deps, buildAction(create, createInput, link));
  if (!made.ok) return { outcome: "denied", reason: made.reason };
  const pageId = newPageId(made.result);
  if (pageId === null) {
    return {
      outcome: "unavailable",
      code: "ERR_POSTMORTEM_PUSH_PARTIAL",
      reason:
        "the Notion page was created, but its id could not be read from the reply, so its body was not added",
    };
  }
  const appendInput: Record<string, unknown> = { parentBlockId: pageId, childrenJson };
  const late = refusedBy(deps, append.toolId, appendInput);
  if (late !== undefined && late.outcome === "refused") {
    return { outcome: "partial", code: "ERR_POSTMORTEM_PUSH_PARTIAL", pageId, reason: late.reason };
  }
  const added = await run(deps, buildAction(append, appendInput, link));
  if (!added.ok) {
    return {
      outcome: "partial",
      code: "ERR_POSTMORTEM_PUSH_PARTIAL",
      pageId,
      reason: added.reason,
    };
  }
  return { outcome: "pushed", pageId };
}

export async function pushPostmortem(
  deps: PushDeps,
  recordId: string,
  target: PushTarget,
  markdown: string,
  titleOverride: string | undefined,
): Promise<PushOutcome> {
  // The link names a record that exists and the version it holds NOW (static D46(e)).
  const link = mintIncidentLink(deps.db, recordId);
  try {
    const split = splitTitleAndBody(markdown, titleOverride);
    return target.kind === "confluence"
      ? await pushConfluence(deps, target, link, split.title, split.body)
      : await pushNotion(deps, target, link, split.title, split.body);
  } catch (e) {
    if (e instanceof PostmortemConvertError) {
      return {
        outcome: "refused",
        code: e.code,
        reason: failureReason(e.message.replace(/^[A-Z_]+: /, "")),
      };
    }
    throw e;
  }
}

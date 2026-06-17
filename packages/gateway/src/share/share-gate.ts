import type { Database } from "bun:sqlite";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  buildShareFile,
  type ShareBody,
  type ShareFile,
  type ShareToolCall,
  type ShareTurn,
} from "./share-format.ts";
import { ensureShareKeypair } from "./share-keypair.ts";
import { redactForShare } from "./share-redaction.ts";
import { insertShareRecord } from "./share-store.ts";

export interface SessionContent {
  readonly turns: readonly ShareTurn[];
  readonly toolCalls: readonly ShareToolCall[];
}

export type ShareSink =
  | { readonly type: "file" }
  | { readonly type: "http"; readonly url: string }
  | { readonly type: "peer"; readonly peerId: string };

export interface CreateShareRequest {
  readonly sessionId: string;
  readonly kind: "transcript" | "recipe";
  readonly sink: ShareSink;
  readonly callerPatterns?: readonly RegExp[];
  readonly expiresAt?: number | null;
}

export interface CreateShareDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly label: string;
  readonly now: () => number;
  readonly collectSession: (sessionId: string) => SessionContent;
  /** Builds the declarative recipe DAG for `--as-recipe` (kind="recipe"). Redacted at the gate. */
  readonly buildRecipe: (sessionId: string) => unknown;
  readonly requestApproval: (preview: unknown, redactionSet: readonly string[]) => Promise<boolean>;
  readonly recordAudit: (e: {
    actionType: string;
    hitlStatus: string;
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }) => void;
}

export type CreateShareResult =
  | { readonly status: "ok"; readonly share: ShareFile }
  | { readonly status: "rejected"; readonly share?: undefined };

/**
 * The I27 outbound-share chokepoint: redact → owner HITL → sign → persist → audit. The sink emit
 * (file write / HTTP POST / peer forward) is wired by the RPC layer (Task 10), not here. A rejected
 * approval persists nothing and emits a `rejected` audit record; an approval signs the redacted body
 * with the Vault-only share keypair, persists a `share_records` row, and emits an `approved` record.
 */
export async function createShare(
  req: CreateShareRequest,
  deps: CreateShareDeps,
): Promise<CreateShareResult> {
  const now = deps.now();

  let previewPayload: unknown;
  let applied: readonly string[];
  let bodyExtras: Pick<ShareBody, "turns" | "toolCalls" | "recipe">;
  if (req.kind === "recipe") {
    const recipe = deps.buildRecipe(req.sessionId);
    const red = redactForShare(recipe, req.callerPatterns ?? []);
    previewPayload = red.redacted;
    applied = red.applied;
    bodyExtras = { recipe: red.redacted }; // turns + toolCalls omitted entirely
  } else {
    const content = deps.collectSession(req.sessionId);
    const red = redactForShare(
      { turns: content.turns, toolCalls: content.toolCalls },
      req.callerPatterns ?? [],
    );
    previewPayload = red.redacted;
    applied = red.applied;
    const r = red.redacted as {
      turns?: readonly ShareTurn[];
      toolCalls?: readonly ShareToolCall[];
    };
    bodyExtras = { turns: r.turns ?? [], toolCalls: r.toolCalls ?? [] };
  }

  const approved = await deps.requestApproval(previewPayload, applied);
  if (!approved) {
    deps.recordAudit({
      actionType: "share.publish",
      hitlStatus: "rejected",
      actionJson: JSON.stringify({
        sessionId: req.sessionId,
        kind: req.kind,
        redactionSet: applied,
        sink: req.sink.type,
      }),
      timestamp: now,
      sessionId: req.sessionId,
    });
    return { status: "rejected" };
  }

  const kp = await ensureShareKeypair(deps.vault);
  const body: ShareBody = {
    kind: req.kind,
    sessionId: req.sessionId,
    createdAt: now,
    expiresAt: req.expiresAt ?? null,
    redactionSet: applied,
    origin: { label: deps.label, pubkey: kp.pubkeyB64 },
    ...bodyExtras,
  };
  const share = buildShareFile(body, kp.privkeyB64, kp.pubkeyB64);

  insertShareRecord(deps.db, {
    contentHash: share.contentHash,
    kind: body.kind,
    sessionId: req.sessionId,
    createdAt: now,
    expiresAt: body.expiresAt,
    redactionSet: applied,
    provenance: share.forwarding,
    bodyJson: JSON.stringify(body),
    sigJson: JSON.stringify(share.sig),
    sink: req.sink.type,
  });
  deps.recordAudit({
    actionType: "share.publish",
    hitlStatus: "approved",
    actionJson: JSON.stringify({
      sessionId: req.sessionId,
      kind: req.kind,
      redactionSet: applied,
      sink: req.sink.type,
      contentHash: share.contentHash,
    }),
    timestamp: now,
    sessionId: req.sessionId,
  });
  return { status: "ok", share };
}

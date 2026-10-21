import { useState } from "react";

import { useIpcQuery } from "../hooks/useIpcQuery";
import { createIpcClient } from "../ipc/client";

export interface AvailableUpdateUi {
  readonly id: string;
  readonly displayName: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly channel: "stable" | "beta";
  readonly publisherStatus: "verified" | "unverified";
  readonly verificationStatus: "verified" | "signature_failed" | "publisher_key_conflict";
}

export interface UpdateApplyResultUi {
  readonly applied: boolean;
  readonly reason?: string;
  readonly hint?: string;
}

/**
 * One row of `migration.list` (gateway `MigrationRowView`, `ipc/migration-rpc.ts`). It carries no
 * filesystem path; the error text has already been redacted by the gateway.
 */
export interface MigrationRowUi {
  readonly id: string;
  readonly legacyServiceId: string;
  readonly extensionId: string;
  readonly version: string | null;
  readonly treeDigest: string | null;
  readonly state: "awaiting_approval" | "approved" | "declined" | "failed";
  readonly error: string | null;
}

interface MigrationListUi {
  readonly migrations: readonly MigrationRowUi[];
}

/** The rows that need the owner: awaiting an answer, or failed. Anything malformed is dropped. */
function actionableMigrations(data: unknown): MigrationRowUi[] {
  if (data === null || typeof data !== "object") return [];
  const rows = (data as { migrations?: unknown }).migrations;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is MigrationRowUi => {
    if (r === null || typeof r !== "object") return false;
    const rec = r as Record<string, unknown>;
    const optionalText = (v: unknown): boolean =>
      v === null || v === undefined || typeof v === "string";
    return (
      typeof rec["id"] === "string" &&
      typeof rec["legacyServiceId"] === "string" &&
      typeof rec["extensionId"] === "string" &&
      optionalText(rec["version"]) &&
      optionalText(rec["error"]) &&
      (rec["state"] === "awaiting_approval" || rec["state"] === "failed")
    );
  });
}

interface PendingUpdatesProps {
  readonly offline: boolean;
  readonly pollIntervalMs?: number;
}

function formatApplyResult(applyResult: {
  readonly id: string;
  readonly result: UpdateApplyResultUi;
}): string {
  if (applyResult.result.applied) {
    return `Updated ${applyResult.id}`;
  }
  const hintSuffix = applyResult.result.hint === undefined ? "" : ` — ${applyResult.result.hint}`;
  return `Update failed: ${applyResult.result.reason}${hintSuffix}`;
}

const DEFAULT_POLL_MS = 5 * 60_000;

export function PendingUpdates({
  offline,
  pollIntervalMs = DEFAULT_POLL_MS,
}: Readonly<PendingUpdatesProps>) {
  const { data, error, refetch } = useIpcQuery<AvailableUpdateUi[]>(
    "extension.checkForUpdates",
    pollIntervalMs,
    undefined,
    { enabled: !offline },
  );
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<{
    id: string;
    result: UpdateApplyResultUi;
  } | null>(null);
  const [inFlight, setInFlight] = useState<string | null>(null);

  const list: AvailableUpdateUi[] = Array.isArray(data) ? data : [];

  const { data: migrationData, refetch: refetchMigrations } = useIpcQuery<MigrationListUi>(
    "migration.list",
    pollIntervalMs,
    undefined,
    { enabled: !offline },
  );
  const migrations = actionableMigrations(migrationData);
  const [migrationError, setMigrationError] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [keeping, setKeeping] = useState<string | null>(null);

  // `migration.accept` blocks until the owner answers the `extension.migrate` prompt (it is in the
  // bridge's NO_TIMEOUT_METHODS), so `keeping` is the pending state for as long as that takes. The
  // params are `{ id }` and nothing else (I46): the desktop never names a package, a registry or a
  // permission. A refusal arrives as an already-redacted error message.
  async function handleKeep(id: string): Promise<void> {
    setMigrationError(null);
    setKeeping(id);
    try {
      await createIpcClient().call<MigrationRowUi>("migration.accept", { id });
    } catch (e) {
      setMigrationError({ id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setKeeping(null);
      refetchMigrations();
    }
  }

  async function handleApply(id: string, toVersion: string): Promise<void> {
    setApplyError(null);
    setApplyResult(null);
    setInFlight(id);
    try {
      const res = await createIpcClient().call<UpdateApplyResultUi>("extension.update", {
        id,
        toVersion,
      });
      setApplyResult({ id, result: res });
      refetch();
    } catch (e) {
      setApplyError(e instanceof Error ? e.message : String(e));
    } finally {
      setInFlight(null);
    }
  }

  if (offline) return null;
  const showUpdates = error === null && list.length > 0;
  if (!showUpdates && migrations.length === 0) return null;

  // A refusal belongs to the row it was raised for: once that row is gone, or shows its own failure
  // text, the message is stale and is not shown.
  const refusedRow = migrations.find((m) => m.id === migrationError?.id);
  const shownMigrationError =
    refusedRow?.state === "awaiting_approval" ? (migrationError?.message ?? null) : null;

  const migrationsSection =
    migrations.length === 0 ? null : (
      <section
        data-testid="pending-migrations"
        className="border rounded p-4 bg-amber-50 border-amber-300 flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold">Pending migrations</h2>
        {shownMigrationError !== null && (
          <p className="text-red-600 text-sm" role="alert" data-testid="migration-error">
            {shownMigrationError}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {migrations.map((m) => {
            const isKeeping = keeping === m.id;
            return (
              <li
                key={m.id}
                data-testid={`pending-migration-row-${m.id}`}
                className="flex items-center justify-between gap-3 border-b border-amber-200 pb-2"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-sm">
                    <strong>{m.legacyServiceId}</strong>{" "}
                    <span className="text-neutral-600">
                      → {m.extensionId}
                      {m.version === null ? "" : ` ${m.version}`}
                    </span>
                  </span>
                  {m.state === "failed" ? (
                    <span className="text-xs text-red-600" data-testid={`migration-failed-${m.id}`}>
                      Migration failed: {m.error ?? "unknown error"}
                    </span>
                  ) : (
                    <span className="text-xs text-neutral-500">
                      Paused until you keep it as a signed extension.
                    </span>
                  )}
                  {isKeeping && (
                    <span
                      className="text-xs text-neutral-600"
                      data-testid={`migration-waiting-${m.id}`}
                    >
                      Waiting for your answer in the approval window…
                    </span>
                  )}
                </div>
                {m.state === "awaiting_approval" && (
                  <button
                    type="button"
                    aria-label={`Keep ${m.legacyServiceId} as ${m.extensionId}`}
                    data-testid={`migration-keep-${m.id}`}
                    disabled={keeping !== null}
                    onClick={() => {
                      void handleKeep(m.id);
                    }}
                    className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
                  >
                    {isKeeping ? "Waiting…" : "Keep"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    );

  if (!showUpdates) return migrationsSection;

  return (
    <>
      {migrationsSection}
      <section
        data-testid="pending-updates"
        className="border rounded p-4 bg-amber-50 border-amber-300 flex flex-col gap-3"
      >
        <h2 className="text-lg font-semibold">Pending updates</h2>
        {applyError !== null && (
          <p className="text-red-600 text-sm" data-testid="apply-error">
            {applyError}
          </p>
        )}
        {applyResult !== null && (
          <p
            className={`text-sm ${applyResult.result.applied ? "text-green-700" : "text-red-600"}`}
            data-testid={`apply-result-${applyResult.id}`}
          >
            {formatApplyResult(applyResult)}
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {list.map((u) => {
            const actionable = u.verificationStatus === "verified";
            const isInFlight = inFlight === u.id;
            return (
              <li
                key={u.id}
                data-testid={`pending-update-row-${u.id}`}
                className="flex items-center justify-between gap-3 border-b border-amber-200 pb-2"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-sm">
                    <strong>{u.displayName}</strong>{" "}
                    <span className="text-neutral-600">
                      {u.fromVersion} → {u.toVersion}
                    </span>
                  </span>
                  <span className="text-xs text-neutral-500 flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded bg-neutral-200">{u.channel}</span>
                    <span
                      className={
                        u.publisherStatus === "verified" ? "text-green-700" : "text-amber-700"
                      }
                    >
                      publisher: {u.publisherStatus}
                    </span>
                    {u.verificationStatus === "publisher_key_conflict" && (
                      <span
                        data-testid={`key-conflict-${u.id}`}
                        className="px-1.5 py-0.5 rounded bg-amber-200 text-amber-900"
                      >
                        publisher key changed — not applied
                      </span>
                    )}
                    {u.verificationStatus === "signature_failed" && (
                      <span
                        data-testid={`signature-failed-${u.id}`}
                        className="px-1.5 py-0.5 rounded bg-red-200 text-red-900"
                      >
                        signature failed — contact publisher
                      </span>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={`Update ${u.id} to ${u.toVersion}`}
                  data-testid={`update-button-${u.id}`}
                  disabled={!actionable || isInFlight}
                  onClick={() => {
                    void handleApply(u.id, u.toVersion);
                  }}
                  className="px-3 py-1 rounded bg-blue-600 text-white text-sm disabled:opacity-40"
                >
                  {isInFlight ? "Updating…" : "Update"}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

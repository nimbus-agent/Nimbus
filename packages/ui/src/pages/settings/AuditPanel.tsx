import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { List, type RowComponentProps } from "react-window";
import { AuditFilterChips } from "../../components/settings/audit/AuditFilterChips";
import { PanelError } from "../../components/settings/PanelError";
import { PanelHeader } from "../../components/settings/PanelHeader";
import { StaleChip } from "../../components/settings/StaleChip";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { useIpcSubscription } from "../../hooks/useIpcSubscription";
import { createIpcClient } from "../../ipc/client";
import type { AuditExportRow, AuditVerifyResult, JsonRpcNotification } from "../../ipc/types";
import { useNimbusStore } from "../../store";
import { rowsToCsv, splitActionType, toDisplayRow } from "./audit/audit-row-utils";

const ROW_HEIGHT = 32;
const LIST_HEIGHT = 480;
const POLL_MS = 60_000;
const MAX_ROWS = 1_000;

function extractRunId(actionType: string, actionJson: string): string | null {
  if (actionType !== "workflow.run.completed") return null;
  try {
    const parsed = JSON.parse(actionJson) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      return typeof rec["runId"] === "string" ? rec["runId"] : null;
    }
  } catch {
    // Malformed JSON — treat as no runId.
  }
  return null;
}

interface ToastState {
  readonly kind: "success" | "error" | "info";
  readonly text: string;
}

function toastColorClass(kind: "success" | "error" | "info"): string {
  if (kind === "success") return "bg-green-700";
  if (kind === "error") return "bg-red-700";
  return "bg-blue-700";
}

function VerifyToast({
  toast,
  onDismiss,
}: {
  readonly toast: ToastState;
  readonly onDismiss: () => void;
}) {
  const colorClass = toastColorClass(toast.kind);
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-3 rounded px-3 py-2 text-sm text-white flex items-start justify-between ${colorClass}`}
    >
      <span data-testid="audit-toast-text">{toast.text}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="ml-2 underline">
        ×
      </button>
    </div>
  );
}

function outcomeClass(outcome: string): string {
  if (outcome === "rejected") return "text-red-500 font-medium";
  if (outcome === "approved") return "text-green-600 font-medium";
  return "text-[var(--color-text-muted)]";
}

export function AuditPanel() {
  const [searchParams] = useSearchParams();
  const runIdFilter = searchParams.get("runId");

  const connectionState = useNimbusStore((s) => s.connectionState);
  const filter = useNimbusStore((s) => s.auditFilter);
  const summary = useNimbusStore((s) => s.auditSummary);
  const inFlight = useNimbusStore((s) => s.auditActionInFlight);
  const setFilter = useNimbusStore((s) => s.setAuditFilter);
  const resetFilter = useNimbusStore((s) => s.resetAuditFilter);
  const setSummary = useNimbusStore((s) => s.setAuditSummary);
  const setInFlight = useNimbusStore((s) => s.setAuditActionInFlight);
  const offline = connectionState === "disconnected";
  const writeDisabled = offline || inFlight;

  const [toast, setToast] = useState<ToastState | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const {
    data: rawRows,
    error: listError,
    refetch: refetchList,
  } = useIpcQuery<
    Array<{
      id: number;
      actionType: string;
      hitlStatus: "approved" | "rejected" | "not_required";
      actionJson: string;
      timestamp: number;
    }>
  >("audit.list", POLL_MS, { limit: MAX_ROWS });

  const refreshSummary = useCallback(async () => {
    try {
      const next = await createIpcClient().auditGetSummary();
      setSummary(next);
    } catch {
      // Summary failure is non-fatal — keep the prior snapshot, just don't update it.
    }
  }, [setSummary]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rawRows?.length is a trigger for summary refresh, not read inside the effect
  useEffect(() => {
    refreshSummary().catch(() => undefined);
  }, [refreshSummary, rawRows?.length]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method === "audit.entryAppended" || n.method === "data.delete.completed") {
        refetchList();
      }
    },
    [refetchList],
  );
  useIpcSubscription<JsonRpcNotification>("gateway://notification", onNotification);

  const displayRows = useMemo(() => {
    if (rawRows === null) return [];
    return rawRows.map((r) => {
      const { service, action } = splitActionType(r.actionType);
      return {
        id: r.id,
        tsIso: new Date(r.timestamp).toISOString(),
        service,
        action,
        outcome: r.hitlStatus,
        rowHash: "", // not present in `audit.list`; populated only in the export pipeline
        actor: "",
        runId: extractRunId(r.actionType, r.actionJson),
      };
    });
  }, [rawRows]);

  const filteredRows = useMemo(() => {
    return displayRows.filter((row) => {
      if (filter.service !== "" && row.service !== filter.service) return false;
      if (filter.outcome !== "all" && row.outcome !== filter.outcome) return false;
      const ms = Date.parse(row.tsIso);
      if (filter.sinceMs !== null && ms < filter.sinceMs) return false;
      if (filter.untilMs !== null && ms > filter.untilMs + 86_399_000) return false;
      return true;
    });
  }, [displayRows, filter]);

  const availableServices = useMemo(() => {
    const set = new Set<string>();
    for (const r of displayRows) set.add(r.service);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [displayRows]);

  const runIdFilteredRows = useMemo(() => {
    if (runIdFilter === null) return filteredRows;
    return filteredRows.filter((row) => row.runId === runIdFilter);
  }, [filteredRows, runIdFilter]);

  const onVerify = useCallback(async () => {
    setInFlight(true);
    setToast({ kind: "info", text: "Verifying audit chain…" });
    try {
      const result: AuditVerifyResult = await createIpcClient().auditVerify(true);
      if (result.ok) {
        setToast({
          kind: "success",
          text: `Chain verified — ${result.totalChecked} rows through id ${result.lastVerifiedId}.`,
        });
      } else {
        setToast({
          kind: "error",
          text: `Chain BROKEN at id ${result.brokenAtId}: expected ${result.expectedHash.slice(0, 12)}…, got ${result.actualHash.slice(0, 12)}…`,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setToast({ kind: "error", text: `Verify failed: ${msg}` });
    } finally {
      setInFlight(false);
    }
  }, [setInFlight]);

  const onExport = useCallback(async () => {
    setInFlight(true);
    setExportError(null);
    try {
      const path = await save({
        title: "Export audit log",
        defaultPath: `audit-${Date.now()}.json`,
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "CSV", extensions: ["csv"] },
        ],
      });
      if (path === null) return;
      const rows: ReadonlyArray<AuditExportRow> = await createIpcClient().auditExport();
      const isCsv = path.toLowerCase().endsWith(".csv");
      const contents = isCsv ? rowsToCsv(rows) : JSON.stringify(rows.map(toDisplayRow), null, 2);
      await writeTextFile(path, contents);
      setToast({ kind: "success", text: `Exported ${rows.length} rows to ${path}` });
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setInFlight(false);
    }
  }, [setInFlight]);

  const Row = useCallback(
    ({ index, style, ariaAttributes }: RowComponentProps) => {
      const row = runIdFilteredRows[index];
      if (!row) return null;
      const isMatch = runIdFilter !== null && row.runId === runIdFilter;
      return (
        <div
          {...ariaAttributes}
          style={style}
          className={`grid grid-cols-[180px_120px_1fr_100px] items-center px-3 text-xs border-b border-[var(--color-border)]${isMatch ? " bg-amber-50 dark:bg-amber-900/20" : ""}`}
          data-testid="audit-row"
          aria-current={isMatch ? "true" : undefined}
        >
          <span className="font-mono text-[var(--color-text-muted)]">{row.tsIso}</span>
          <span className="font-medium">{row.service}</span>
          <span>{row.action}</span>
          <span className={outcomeClass(row.outcome)}>{row.outcome}</span>
        </div>
      );
    },
    [runIdFilteredRows, runIdFilter],
  );

  return (
    <section className="p-6 space-y-3">
      <PanelHeader
        title="Audit"
        description="Tamper-evident BLAKE3-chained audit log. Up to 1,000 most recent rows shown; verify or export the full chain below."
        livePill={offline ? <StaleChip /> : undefined}
      />

      {summary !== null && (
        <div className="text-xs text-[var(--color-text-muted)]">
          Total rows: {summary.total} · approved: {summary.byOutcome.approved ?? 0} · rejected:{" "}
          {summary.byOutcome.rejected ?? 0} · auto: {summary.byOutcome.not_required ?? 0}
        </div>
      )}

      <AuditFilterChips
        filter={filter}
        availableServices={availableServices}
        onChange={setFilter}
        onReset={resetFilter}
        disabled={offline}
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onVerify}
          disabled={writeDisabled}
          className="px-3 py-1.5 text-sm rounded bg-[var(--color-accent)] text-white disabled:opacity-50"
        >
          Verify chain
        </button>
        <button
          type="button"
          onClick={onExport}
          disabled={writeDisabled}
          className="px-3 py-1.5 text-sm rounded border border-[var(--color-border)] disabled:opacity-50"
        >
          Export…
        </button>
        <span className="text-xs text-[var(--color-text-muted)]">
          {runIdFilteredRows.length} of {displayRows.length} rows
        </span>
      </div>

      {listError !== null && (
        <PanelError
          message={`Failed to load audit log: ${listError}`}
          onRetry={() => refetchList()}
        />
      )}
      {exportError !== null && (
        <PanelError
          message={`Export failed: ${exportError}`}
          onRetry={() => setExportError(null)}
        />
      )}
      {toast !== null && <VerifyToast toast={toast} onDismiss={() => setToast(null)} />}

      {runIdFilter !== null && runIdFilteredRows.length === 0 && (
        <p
          data-testid="audit-runid-banner"
          className="text-sm text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded p-3 my-2"
        >
          No audit entries found for run <code>{runIdFilter}</code>. It may have been pruned from
          the operational run history; the audit log row survives if it was ever created.
        </p>
      )}

      <div className="border border-[var(--color-border)] rounded">
        <div className="grid grid-cols-[180px_120px_1fr_100px] px-3 py-1.5 text-xs font-semibold border-b border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
          <span>Timestamp</span>
          <span>Service</span>
          <span>Action</span>
          <span>Outcome</span>
        </div>
        <List
          style={{ height: LIST_HEIGHT, width: "100%" }}
          rowCount={runIdFilteredRows.length}
          rowHeight={ROW_HEIGHT}
          rowComponent={Row}
          rowProps={{}}
        />
      </div>
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { PanelError } from "../../components/settings/PanelError";
import { PanelHeader } from "../../components/settings/PanelHeader";
import { StaleChip } from "../../components/settings/StaleChip";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { createIpcClient } from "../../ipc/client";
import type {
  ConnectorConfigChangedPayload,
  ConnectorHealth,
  ConnectorStatus,
  JsonRpcNotification,
} from "../../ipc/types";
import { useNimbusStore } from "../../store";
import type { PersistedConnectorRow } from "../../store/slices/connectors";
import {
  fromMs,
  type IntervalParts,
  type IntervalUnit,
  MIN_INTERVAL_MS,
  toMs,
} from "./connectors/interval-parts";

const DEPTH_OPTIONS = [
  { value: "metadata_only", label: "Metadata only" },
  { value: "summary", label: "Summary" },
  { value: "full", label: "Full" },
] as const;

const DEBOUNCE_MS = 500;

function dotClass(h: ConnectorHealth): string {
  switch (h) {
    case "healthy":
      return "bg-green-500";
    case "degraded":
      return "bg-yellow-500";
    case "rate_limited":
      return "bg-amber-500";
    case "unauthenticated":
      return "bg-orange-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-gray-400";
  }
}

function asPersistedRow(s: ConnectorStatus): PersistedConnectorRow {
  return {
    service: s.name,
    intervalMs: s.intervalMs ?? 60_000,
    depth: s.depth ?? "summary",
    enabled: s.enabled ?? true,
    health: s.health,
  };
}

type ConnectorDepth = "metadata_only" | "summary" | "full";

interface RowProps {
  readonly row: PersistedConnectorRow;
  readonly inFlight: boolean;
  readonly writeDisabled: boolean;
  readonly highlighted: boolean;
  readonly onPatch: (patch: {
    intervalMs?: number;
    depth?: ConnectorDepth;
    enabled?: boolean;
  }) => Promise<void>;
}

function ConnectorRow({ row, inFlight, writeDisabled, highlighted, onPatch }: RowProps) {
  const init = fromMs(row.intervalMs);
  const [parts, setParts] = useState<IntervalParts>(init);
  const [displayValue, setDisplayValue] = useState<string>(String(init.value));
  const [validationError, setValidationError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const next = fromMs(row.intervalMs);
    setParts(next);
    setDisplayValue(String(next.value));
    setValidationError(null);
  }, [row.intervalMs]);

  const scheduleIntervalSave = useCallback(
    (next: IntervalParts) => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void onPatch({ intervalMs: toMs(next) });
      }, DEBOUNCE_MS);
    },
    [onPatch],
  );

  const validateAndSchedule = useCallback(
    (next: IntervalParts) => {
      const ms = toMs(next);
      if (ms < MIN_INTERVAL_MS) {
        setValidationError("minimum 60 seconds");
        if (debounceRef.current !== null) {
          clearTimeout(debounceRef.current);
          debounceRef.current = null;
        }
        return;
      }
      setValidationError(null);
      scheduleIntervalSave(next);
    },
    [scheduleIntervalSave],
  );

  const onValueChange = useCallback(
    (raw: string) => {
      setDisplayValue(raw);
      const v = Number.parseInt(raw, 10);
      if (!Number.isFinite(v) || v < 1) {
        return;
      }
      const next: IntervalParts = { ...parts, value: v };
      setParts(next);
      validateAndSchedule(next);
    },
    [parts, validateAndSchedule],
  );

  const onUnitChange = useCallback(
    (u: IntervalUnit) => {
      const next: IntervalParts = { ...parts, unit: u };
      setParts(next);
      validateAndSchedule(next);
    },
    [parts, validateAndSchedule],
  );

  return (
    <li
      data-testid={`connector-row-${row.service}`}
      className={[
        "flex items-center gap-4 px-4 py-3",
        highlighted ? "ring-2 ring-[var(--color-accent)]" : "",
      ].join(" ")}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dotClass(row.health)}`} aria-hidden />
      <span className="font-medium w-28">{row.service}</span>

      <label className="flex items-center gap-1 text-sm">
        <span className="sr-only" id={`${row.service}-interval-label`}>
          {row.service} interval
        </span>
        <input
          type="number"
          min={1}
          step={1}
          value={displayValue}
          disabled={writeDisabled}
          onChange={(e) => onValueChange(e.target.value)}
          aria-label={`${row.service} interval value`}
          aria-invalid={validationError === null ? undefined : true}
          className={[
            "w-16 px-2 py-1 rounded border bg-[var(--color-bg-subtle)] disabled:opacity-50",
            validationError === null
              ? "border-[var(--color-border)]"
              : "border-[var(--color-danger-border)]",
          ].join(" ")}
        />
        <select
          value={parts.unit}
          disabled={writeDisabled}
          onChange={(e) => onUnitChange(e.target.value as IntervalUnit)}
          aria-label={`${row.service} interval unit`}
          className="px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] disabled:opacity-50"
        >
          <option value="sec">sec</option>
          <option value="min">min</option>
          <option value="hr">hr</option>
        </select>
      </label>

      <select
        value={row.depth}
        disabled={writeDisabled}
        onChange={(e) =>
          void onPatch({ depth: e.target.value as "metadata_only" | "summary" | "full" })
        }
        aria-label={`${row.service} depth`}
        className="px-2 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] disabled:opacity-50"
      >
        {DEPTH_OPTIONS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      <label className="flex items-center gap-1 text-sm">
        <input
          type="checkbox"
          checked={row.enabled}
          disabled={writeDisabled}
          onChange={(e) => void onPatch({ enabled: e.target.checked })}
          aria-label={`${row.service} enabled`}
        />
        <span>Enabled</span>
      </label>

      {validationError !== null && (
        <span className="text-xs text-[var(--color-danger-text)]">{validationError}</span>
      )}
      {inFlight && validationError === null && (
        <span className="text-xs text-[var(--color-text-muted)]">Saving…</span>
      )}
    </li>
  );
}

export function ConnectorsPanel() {
  const connectorsList = useNimbusStore((s) => s.connectorsList);
  const perServiceInFlight = useNimbusStore((s) => s.perServiceInFlight);
  const highlightService = useNimbusStore((s) => s.highlightService);
  const connectionState = useNimbusStore((s) => s.connectionState);
  const setConnectorsList = useNimbusStore((s) => s.setConnectorsList);
  const setConnectorInFlight = useNimbusStore((s) => s.setConnectorInFlight);
  const setHighlightService = useNimbusStore((s) => s.setHighlightService);
  const patchConnectorRow = useNimbusStore((s) => s.patchConnectorRow);

  const [searchParams] = useSearchParams();

  const offline = connectionState === "disconnected";
  const writeDisabled = offline;

  useEffect(() => {
    const q = searchParams.get("highlight");
    setHighlightService(q ?? null);
  }, [searchParams, setHighlightService]);

  const {
    data: listStatusRows,
    error: fetchError,
    refetch,
  } = useIpcQuery<ConnectorStatus[]>("connector.listStatus", 30_000);

  useEffect(() => {
    if (listStatusRows === null) return;
    setConnectorsList(listStatusRows.map(asPersistedRow));
  }, [listStatusRows, setConnectorsList]);

  const onNotification = useCallback(
    (n: JsonRpcNotification) => {
      if (n.method !== "connector.configChanged") return;
      const p = n.params as ConnectorConfigChangedPayload | null;
      if (p === null || typeof p.service !== "string") return;
      patchConnectorRow(p.service, {
        intervalMs: p.intervalMs,
        depth: p.depth,
        enabled: p.enabled,
      });
    },
    [patchConnectorRow],
  );
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void createIpcClient()
      .subscribe(onNotification)
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [onNotification]);

  const buildPatch = useCallback(
    (service: string) =>
      async (patch: {
        intervalMs?: number;
        depth?: "metadata_only" | "summary" | "full";
        enabled?: boolean;
      }) => {
        setConnectorInFlight(service, true);
        try {
          await createIpcClient().connectorSetConfig(service, patch);
          patchConnectorRow(service, patch);
        } finally {
          setConnectorInFlight(service, false);
        }
      },
    [setConnectorInFlight, patchConnectorRow],
  );

  const rows = useMemo(() => connectorsList, [connectorsList]);

  return (
    <section className="p-6 space-y-6">
      <PanelHeader
        title="Connectors"
        description="Sync interval, reindex depth, and enable/disable per connector. Minimum interval is 60 seconds."
        livePill={offline ? <StaleChip /> : undefined}
      />
      {fetchError !== null && (
        <PanelError
          message={`Failed to load connector status: ${fetchError}`}
          onRetry={() => refetch()}
        />
      )}
      <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md">
        {rows.map((r) => (
          <ConnectorRow
            key={r.service}
            row={r}
            inFlight={perServiceInFlight[r.service] === true}
            writeDisabled={writeDisabled}
            highlighted={highlightService === r.service}
            onPatch={buildPatch(r.service)}
          />
        ))}
      </ul>
    </section>
  );
}

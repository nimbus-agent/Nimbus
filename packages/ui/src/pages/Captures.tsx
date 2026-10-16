import { type ReactNode, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { CaptureDetail } from "../components/captures/CaptureDetail";
import { CaptureList } from "../components/captures/CaptureList";
import { PageHeader } from "../components/chrome/PageHeader";
import { asCaptureList } from "../hooks/useCaptures";
import { useIpcQuery } from "../hooks/useIpcQuery";
import type { CaptureKind, CaptureState, CaptureList as List } from "../ipc/types";

const KINDS: readonly CaptureKind[] = ["note", "decision", "term", "link", "action"];
const STATES: readonly CaptureState[] = [
  "live",
  "proposed",
  "accepted",
  "rejected",
  "revoked",
  "executing",
  "executed",
  "failed",
  "expired",
];

const EMPTY = "No captures. MCP clients write here when `[mcp_sink]` is enabled in nimbus.toml.";

function isCaptureState(v: string): v is CaptureState {
  return (STATES as readonly string[]).includes(v);
}

/**
 * The MCP capture sink, read-only (I28, I7): `captures.list` and `captures.get` are the only
 * methods this page can reach. Accepting, rejecting, revoking and purging stay in a terminal.
 * Bound: `captures.list` runs the gateway's action-expiry sweep, so opening this page can move an
 * overdue proposed action to `expired`, exactly as `nimbus captures list` does.
 */
export function Captures(): ReactNode {
  const [kind, setKind] = useState<CaptureKind | null>(null);
  const [state, setState] = useState<CaptureState | null>(null);
  const params = useMemo(() => {
    const p: Record<string, unknown> = { limit: 200 };
    if (kind !== null) p["kind"] = kind;
    if (state !== null) p["state"] = state;
    return p;
  }, [kind, state]);
  const { data, error, refetch } = useIpcQuery<unknown>("captures.list", 60_000, params);
  const list = asCaptureList(data);
  const [search] = useSearchParams();
  const selectedId = search.get("id");

  return (
    <>
      <PageHeader title="Captures" />
      <div className="p-6 space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <fieldset className="flex gap-1 border-0 m-0 p-0">
            <legend className="sr-only">Kind</legend>
            {[null, ...KINDS].map((k) => (
              <button
                key={k ?? "all"}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={`px-2 py-1 rounded-md border border-[var(--color-border)] ${kind === k ? "bg-[rgba(120,144,255,0.15)]" : ""}`}
              >
                {k ?? "All"}
              </button>
            ))}
          </fieldset>
          <label className="flex items-center gap-1">
            State
            <select
              value={state ?? ""}
              onChange={(e) => setState(isCaptureState(e.target.value) ? e.target.value : null)}
              className="border border-[var(--color-border)] rounded-md bg-transparent px-1 py-1"
            >
              <option value="">All</option>
              {STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refetch}
            className="ml-auto px-2 py-1 rounded-md border border-[var(--color-border)]"
          >
            Refresh
          </button>
        </div>
        <Body list={list} error={error} selectedId={selectedId} />
      </div>
    </>
  );
}

function Body(props: {
  readonly list: List | null;
  readonly error: string | null;
  readonly selectedId: string | null;
}): ReactNode {
  if (props.error !== null && props.list === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load captures: ${props.error}. From a terminal: nimbus captures list`}
      </p>
    );
  }
  if (props.list === null) return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  if (props.list.captures.length === 0) return <p className="text-sm">{EMPTY}</p>;
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-4">
      <CaptureList
        captures={props.list.captures}
        selectedId={props.selectedId}
        nowMs={Date.now()}
      />
      {props.selectedId !== null && <CaptureDetail key={props.selectedId} id={props.selectedId} />}
    </div>
  );
}

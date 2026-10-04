import { type ReactNode, useEffect, useRef } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { asPushedBriefGet, useOncallBriefs } from "../../hooks/useOncallBriefs";
import { DeliveryStrip } from "./DeliveryStrip";

export function BriefDetail({
  incidentId,
  onPruned,
}: {
  readonly incidentId: string;
  readonly onPruned: (incidentId: string) => void;
}): ReactNode {
  const { data, error, refetch } = useIpcQuery<unknown>("oncall.pushedGet", 60_000, { incidentId });
  const { lastPushed } = useOncallBriefs();
  useEffect(() => {
    if (lastPushed !== null && lastPushed.incidentId === incidentId) refetch();
  }, [lastPushed, incidentId, refetch]);
  const got = asPushedBriefGet(data);
  const isPruned = got !== undefined && got.brief === null;
  // onPruned changes identity when the URL changes (it closes over setParams), and clearing the id
  // is exactly what it does; keying the effect on it would announce the same prune twice.
  const onPrunedRef = useRef(onPruned);
  onPrunedRef.current = onPruned;
  useEffect(() => {
    if (isPruned) onPrunedRef.current(incidentId);
  }, [isPruned, incidentId]);

  if (error !== null && got === undefined) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load pushed briefs: ${error}. From a terminal: nimbus oncall pushed`}
      </p>
    );
  }
  if (got === undefined || got.brief === null || got.brief.incidentId !== incidentId) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  }
  const b = got.brief;
  return (
    <article aria-label="Pushed brief" className="space-y-3">
      <DeliveryStrip delivery={b.delivery} />
      {b.status === "failed" ? (
        <div className="text-sm space-y-1">
          <p>{`The brief for ${b.incidentId} could not be assembled: ${b.failureCode ?? "unknown"}`}</p>
          <pre className="font-mono text-xs">{`nimbus oncall pushed ${b.incidentId} --retry`}</pre>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-xs border border-[var(--color-border)] rounded-md p-3">
          {b.briefMarkdown ?? ""}
        </pre>
      )}
    </article>
  );
}

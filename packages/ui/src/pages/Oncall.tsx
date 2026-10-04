import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader } from "../components/chrome/PageHeader";
import { BriefDetail } from "../components/oncall/BriefDetail";
import { BriefList } from "../components/oncall/BriefList";
import { useOncallBriefs } from "../hooks/useOncallBriefs";
import { useNimbusStore } from "../store";

const PUSH_OFF = "On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.";
const IDENTITY_UNRESOLVED =
  "On-call push is enabled but your identity is unresolved, so no incident can be selected. Set [user] me_person_id in nimbus.toml or `git config user.email`.";

export function Oncall(): ReactNode {
  const { list, error, refetch } = useOncallBriefs();
  const [params, setParams] = useSearchParams();
  const markPushedSeen = useNimbusStore((s) => s.markPushedSeen);
  // The notice names the LAST pruned id; the set remembers EVERY one, so several pruned rows at the
  // head of a stale list cannot ping-pong the auto-select between them.
  const [pruned, setPruned] = useState<string | null>(null);
  const [prunedIds, setPrunedIds] = useState<ReadonlySet<string>>(new Set());
  const briefs = list?.briefs ?? [];
  const newest = briefs[0];
  const selectedId = params.get("id");

  // Live arrival while the page is open must not light the dot: mark EVERY new newest as seen.
  const newestCreatedAt = newest?.createdAt;
  useEffect(() => {
    if (newestCreatedAt !== undefined) markPushedSeen(newestCreatedAt);
  }, [newestCreatedAt, markPushedSeen]);

  // Auto-select ONLY when nothing is selected, so an arrival never yanks the reader away. The target
  // skips a just-pruned id: the cached list can still name it until the list refetch below lands,
  // and re-selecting it would remount BriefDetail, fetch `{ brief: null }` again, clear `id` again,
  // and loop (plan review section 2.1).
  const autoId = briefs.find((b) => !prunedIds.has(b.incidentId))?.incidentId;
  useEffect(() => {
    if (selectedId === null && autoId !== undefined) setParams({ id: autoId }, { replace: true });
  }, [selectedId, autoId, setParams]);

  const onSelect = useCallback(
    (id: string) => {
      if (id === selectedId) return; // re-clicking the open row must not push a duplicate entry
      setPruned(null);
      setParams({ id });
    },
    [setParams, selectedId],
  );
  const onPruned = useCallback(
    (id: string) => {
      setPruned(id);
      setPrunedIds((prev) => new Set(prev).add(id));
      setParams({}, { replace: true });
      refetch(); // the list may still carry the pruned row; refresh it rather than wait 60 s
    },
    [setParams, refetch],
  );

  return (
    <>
      <PageHeader title="On-call" />
      <div className="p-6 space-y-4">
        {pruned !== null && (
          <p className="text-sm">{`${pruned} was pruned (older than retention_days).`}</p>
        )}
        <Body
          list={list}
          error={error}
          selectedId={selectedId}
          onSelect={onSelect}
          onPruned={onPruned}
        />
      </div>
    </>
  );
}

function Body(props: {
  readonly list: ReturnType<typeof useOncallBriefs>["list"];
  readonly error: string | null;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onPruned: (id: string) => void;
}): ReactNode {
  if (props.error !== null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load pushed briefs: ${props.error}. From a terminal: nimbus oncall pushed`}
      </p>
    );
  }
  if (props.list === null) return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  if (props.list.briefs.length === 0) {
    if (!props.list.enabled) return <p className="text-sm">{PUSH_OFF}</p>;
    if (props.list.identity === "unresolved")
      return <p className="text-sm">{IDENTITY_UNRESOLVED}</p>;
    return <p className="text-sm">No pushed briefs yet.</p>;
  }
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_2fr] gap-4">
      <BriefList
        briefs={props.list.briefs}
        selectedId={props.selectedId}
        onSelect={props.onSelect}
        nowMs={Date.now()}
      />
      {props.selectedId !== null && (
        <BriefDetail
          key={props.selectedId}
          incidentId={props.selectedId}
          onPruned={props.onPruned}
        />
      )}
    </div>
  );
}

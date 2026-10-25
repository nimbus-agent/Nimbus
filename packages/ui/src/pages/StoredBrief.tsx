import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { CopyMarkdownButton } from "../components/briefs/CopyMarkdownButton";
import { PageHeader } from "../components/chrome/PageHeader";
import { Markdown } from "../components/markdown/Markdown";
import { useIpcQuery } from "../hooks/useIpcQuery";
import { useRolePacks } from "../hooks/useRolePacks";
import type { FleetBriefRow, FleetShowResult } from "../ipc/types";

function narrow(v: unknown): FleetShowResult | null {
  if (v === null || typeof v !== "object" || !("brief" in v)) return null;
  const b = (v as { brief: unknown }).brief;
  if (b === null) return { brief: null };
  if (typeof b !== "object") return null;
  const r = b as Partial<FleetBriefRow>;
  if (typeof r.id !== "string" || typeof r.agentMethod !== "string") return null;
  return { brief: r as FleetBriefRow };
}

function BackLink(): ReactNode {
  return (
    <Link to="/briefs" className="text-sm">
      ← Briefs
    </Link>
  );
}

export function StoredBrief(): ReactNode {
  const { id = "" } = useParams();
  // `useIpcQuery` keeps the previous `data` while new params load, and the router reuses this
  // element across `:id` changes: the key gives each id a fresh hook state.
  return <StoredBriefView key={id} id={id} />;
}

function StoredBriefView({ id }: { readonly id: string }): ReactNode {
  const { catalog } = useRolePacks();
  const { data, error } = useIpcQuery<unknown>("fleet.show", 300_000, { id });
  const result = narrow(data);
  const row = result?.brief ?? null;

  let body: ReactNode;
  if (result === null) {
    body = error === null ? <p className="text-sm">Loading…</p> : <p role="alert">{error}</p>;
  } else if (row === null) {
    body = (
      <div className="space-y-2">
        <p className="text-sm">This stored brief is no longer available.</p>
        <Link to="/briefs" className="text-sm">
          Pick a brief to run
        </Link>
      </div>
    );
  } else {
    const agent = catalog?.agents.find((a) => a.method === row.agentMethod);
    body = (
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-fg-muted)]">
          {`${agent?.displayName ?? row.agentMethod} · job ${row.jobId} · ${new Date(row.createdAt).toLocaleString()}`}
        </p>
        {row.briefMarkdown === null ? (
          <p className="text-sm">This run produced no text.</p>
        ) : (
          <>
            <CopyMarkdownButton text={row.briefMarkdown} />
            <Markdown text={row.briefMarkdown} />
          </>
        )}
      </div>
    );
  }
  return (
    <>
      <PageHeader title="Stored brief" />
      <div className="p-6 space-y-4">
        <BackLink />
        {body}
      </div>
    </>
  );
}

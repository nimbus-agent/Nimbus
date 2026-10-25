import type { ReactNode } from "react";
import { Link } from "react-router";
import { hasRequiredParams } from "../../briefs/brief-form";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { useOncallBriefs } from "../../hooks/useOncallBriefs";
import type { CatalogAgent, FleetBriefsResult } from "../../ipc/types";
import { Markdown } from "../markdown/Markdown";
import { formatAge } from "../oncall/format";

/** First `max` non-blank lines, after dropping the leading `# ` title every brief opens with. */
export function previewLines(markdown: string, max = 8): string {
  const lines = markdown.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  const body = first >= 0 && lines[first]?.startsWith("# ") ? lines.slice(first + 1) : lines;
  return body
    .filter((l) => l.trim() !== "")
    .slice(0, max)
    .join("\n");
}

const LINK = "text-sm text-[var(--color-accent)] hover:underline";

function Shell(props: {
  readonly agent: CatalogAgent;
  readonly children: ReactNode;
  readonly action: ReactNode;
}): ReactNode {
  return (
    <article className="rounded border border-[var(--color-border)] p-3 flex flex-col gap-2">
      <h3 className="font-medium text-sm">{props.agent.displayName}</h3>
      <div className="flex-1 text-sm">{props.children}</div>
      <div>{props.action}</div>
    </article>
  );
}

function RunLink({ agent }: { readonly agent: CatalogAgent }): ReactNode {
  return (
    <Link className={LINK} to={`/briefs/${agent.name}`}>
      Run
    </Link>
  );
}

const NONE = <p className="text-[var(--color-fg-muted)]">No stored brief yet.</p>;

function OncallCard({ agent }: { readonly agent: CatalogAgent }): ReactNode {
  const newest = useOncallBriefs().list?.briefs[0];
  if (newest === undefined)
    return (
      <Shell agent={agent} action={<RunLink agent={agent} />}>
        {NONE}
      </Shell>
    );
  return (
    <Shell
      agent={agent}
      action={
        <Link className={LINK} to={`/oncall?id=${encodeURIComponent(newest.incidentId)}`}>
          Open
        </Link>
      }
    >
      <p>
        {newest.title ?? newest.incidentId}
        {newest.service === null ? "" : ` · ${newest.service}`}
      </p>
      <p className="text-[var(--color-fg-muted)]">{formatAge(newest.createdAt, Date.now())}</p>
    </Shell>
  );
}

function StoredCard({ agent }: { readonly agent: CatalogAgent }): ReactNode {
  const needsParams = hasRequiredParams(agent);
  const { data, error } = useIpcQuery<FleetBriefsResult>(
    "fleet.briefs",
    60_000,
    { agentMethod: agent.method, nonSweep: true, withMarkdown: true, limit: 1 },
    { enabled: !needsParams },
  );
  // A failed query reads as "nothing stored": the card has no error state by design.
  const row = needsParams ? undefined : data?.briefs[0];
  // No "nothing stored" claim until the first fetch has answered (a result or an error).
  const firstFetchInFlight = !needsParams && data === null && error === null;
  if (row === undefined)
    return (
      <Shell agent={agent} action={<RunLink agent={agent} />}>
        {needsParams || firstFetchInFlight ? null : NONE}
      </Shell>
    );
  return (
    <Shell
      agent={agent}
      action={
        <Link className={LINK} to={`/briefs/stored/${encodeURIComponent(row.id)}`}>
          Open
        </Link>
      }
    >
      <p className="text-[var(--color-fg-muted)]">{formatAge(row.createdAt, Date.now())}</p>
      <div className="max-h-40 overflow-hidden">
        <Markdown text={previewLines(row.briefMarkdown ?? "")} />
      </div>
    </Shell>
  );
}

export function AgentCard({ agent }: { readonly agent: CatalogAgent }): ReactNode {
  return agent.name === "oncall" ? <OncallCard agent={agent} /> : <StoredCard agent={agent} />;
}

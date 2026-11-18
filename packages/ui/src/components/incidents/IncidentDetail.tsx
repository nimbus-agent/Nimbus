import type { ReactNode } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { Markdown } from "../markdown/Markdown";
import { asIncidentGet } from "./guards";
import { IncidentProposals } from "./IncidentProposals";
import { IncidentTimeline } from "./IncidentTimeline";
import { safeText } from "./safe";

export function IncidentDetail({ id }: { readonly id: string }): ReactNode {
  const { data, error } = useIpcQuery<unknown>("incident.get", 60_000, { id });
  const got = asIncidentGet(data);
  if (error !== null && got === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load this incident: ${safeText(error)}. From a terminal: nimbus incident show ${safeText(id, 120)}`}
      </p>
    );
  }
  if (got === null) return <p className="text-sm text-[var(--color-fg-muted)]">Loading...</p>;
  const rec = got.record;
  if (rec === null) {
    return (
      <p className="text-sm">{`No record is stored for this incident (${safeText(got.reason ?? "unknown", 40)}). From a terminal: nimbus incident show ${safeText(id, 120)}`}</p>
    );
  }
  const s = rec.summary;
  return (
    <article aria-label="Incident" className="space-y-3">
      <h2 className="font-medium">{safeText(s.title, 200)}</h2>
      <p className="text-xs text-[var(--color-fg-muted)]">
        {`${safeText(s.triggerService, 40)} - ${safeText(s.status, 20)} - version ${String(s.version)}${rec.triggerStillIndexed ? "" : " - the trigger item is no longer indexed"}`}
      </p>
      <div className="border border-[var(--color-border)] rounded-md p-3">
        <Markdown text={safeText(rec.markdown, 200_000)} />
      </div>
      {rec.cascade !== null && (
        <section aria-label="Cascade" className="space-y-1">
          <h3 className="text-sm font-medium">Cascade</h3>
          {rec.cascade.status === "unavailable" ? (
            <p className="text-xs">The cascade could not be read right now.</p>
          ) : (
            <>
              {rec.cascade.truncated && (
                <p className="text-xs">
                  More records are open than the cascade reads; its membership can be incomplete.
                </p>
              )}
              <div className="border border-[var(--color-border)] rounded-md p-3">
                <Markdown text={safeText(rec.cascade.markdown, 50_000)} />
              </div>
            </>
          )}
        </section>
      )}
      <section aria-label="Versions" className="text-xs text-[var(--color-fg-muted)]">
        {`Versions: ${rec.versions.map((v) => String(v.version)).join(", ")}`}
      </section>
      <IncidentTimeline recordId={s.id} />
      <IncidentProposals recordId={s.id} />
    </article>
  );
}

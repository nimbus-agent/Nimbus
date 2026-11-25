import type { ReactNode } from "react";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import type { IncidentProposal } from "../../ipc/types";
import { CopyMarkdownButton } from "../briefs/CopyMarkdownButton";
import { asIncidentProposals } from "./guards";
import { safeText, stamp } from "./safe";

/** The gateway mints both ids; a copied shell command is offered only for ids of exactly that shape. */
const RECORD_ID_RE = /^inc_[0-9a-f]{16}$/;
const PROPOSAL_ID_RE = /^prp_[0-9a-f]{16}$/;

/**
 * The terminal command that runs one proposal, or `null` when either id is not the gateway's own shape
 * (a pasted command must never carry text the gateway did not mint). The desktop never runs it (§ 6).
 */
export function remediateCommand(recordId: string, proposalId: string): string | null {
  return RECORD_ID_RE.test(recordId) && PROPOSAL_ID_RE.test(proposalId)
    ? `nimbus incident remediate ${recordId} --pick ${proposalId}`
    : null;
}

function confidenceText(c: number | null): string {
  return c === null ? "not scored" : String(c);
}

function inputText(input: unknown): string {
  try {
    return JSON.stringify(input ?? null, null, 2) ?? "null";
  } catch {
    return "(the input could not be shown)";
  }
}

function blastText(blast: NonNullable<IncidentProposal["evidence"]>["blast"]): string {
  const service = safeText(blast.service ?? "unknown service", 80);
  const env = blast.environment === null ? "" : ` (${safeText(blast.environment, 40)})`;
  const deps =
    blast.dependents.length === 0
      ? "none known"
      : blast.dependents.map((d) => safeText(d, 80)).join(", ");
  const more = blast.dependentsTruncated ? " and more" : "";
  return `Blast radius: ${service}${env}; dependents: ${deps}${more}`;
}

/** What the owner can do next: copy the command for an open proposal, or renew a closed one. */
function NextStep({
  recordId,
  p,
  advisory,
}: {
  readonly recordId: string;
  readonly p: IncidentProposal;
  readonly advisory: boolean;
}): ReactNode {
  if (p.status !== "proposed") {
    return (
      <p className="text-[var(--color-fg-muted)]">
        {`This proposal is ${safeText(p.status, 20)}. List the proposals again from a terminal to renew it: nimbus incident remediate ${safeText(recordId, 40)}`}
      </p>
    );
  }
  const cmd = remediateCommand(recordId, p.id);
  if (cmd === null || advisory) return null;
  return (
    <div className="flex items-center gap-2">
      <code className="font-mono">{cmd}</code>
      <CopyMarkdownButton text={cmd} label="Copy command" />
    </div>
  );
}

function Proposal({
  recordId,
  p,
  advisory,
}: {
  readonly recordId: string;
  readonly p: IncidentProposal;
  readonly advisory: boolean;
}): ReactNode {
  const ev = p.evidence;
  return (
    <li className="border border-[var(--color-border)] rounded-md p-3 space-y-1 text-xs">
      {p.irreversibleReason !== null && (
        <p className="font-medium">{`Irreversible: ${safeText(p.irreversibleReason, 300)}`}</p>
      )}
      <p className="font-medium">
        {`${safeText(p.kind, 40)} - ${safeText(p.toolId, 80)} - ${safeText(p.status, 20)}`}
      </p>
      <p className="text-[var(--color-fg-muted)]">
        {`Reversibility: ${safeText(p.reversibility, 40)} - confidence ${confidenceText(p.confidence)} - expires ${stamp(p.expiresAtMs)}`}
      </p>
      {ev !== null && (
        <>
          <p>{`Rule: ${safeText(ev.rule, 80)} - target: ${safeText(ev.target, 200)}`}</p>
          <p>{blastText(ev.blast)}</p>
          <p>{`Dry run: ${safeText(ev.dryRun, 300)}`}</p>
          {ev.confidence !== null && (
            <ul aria-label="Confidence terms">
              {ev.confidence.terms.map((t) => (
                <li key={t.name}>
                  {`${t.met ? "met" : "not met"}: ${safeText(t.name, 80)} (${String(t.weight)})`}
                </li>
              ))}
            </ul>
          )}
          {ev.items.length > 0 && (
            <p className="text-[var(--color-fg-muted)]">
              {`Evidence: ${ev.items.map((i) => safeText(i, 120)).join(", ")}`}
            </p>
          )}
        </>
      )}
      <pre className="font-mono whitespace-pre-wrap break-all bg-[var(--color-bg-subtle)] p-2 rounded">
        {safeText(inputText(p.input), 4_000)}
      </pre>
      <NextStep recordId={recordId} p={p} advisory={advisory} />
    </li>
  );
}

/** Read-only (IC10b): `incident.proposals` and nothing else. Running one is the terminal's job (§ 6). */
export function IncidentProposals({ recordId }: { readonly recordId: string }): ReactNode {
  const { data, error } = useIpcQuery<unknown>("incident.proposals", 60_000, { id: recordId });
  const res = asIncidentProposals(data);
  if (error !== null && res === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load the proposals: ${safeText(error)}. From a terminal: nimbus incident remediate ${safeText(recordId, 120)}`}
      </p>
    );
  }
  if (res?.recordId !== recordId) {
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading proposals...</p>;
  }
  return (
    <section aria-label="Proposals" className="space-y-2">
      <h3 className="text-sm font-medium">Proposals</h3>
      {res.advisory && (
        <p className="text-xs">
          Advisory mode is on: proposals are shown, nothing is run (nimbus incident advisory off).
        </p>
      )}
      {res.proposals.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">No remediation is proposed.</p>
      ) : (
        <ul className="space-y-2">
          {res.proposals.map((p) => (
            <Proposal key={p.id} recordId={recordId} p={p} advisory={res.advisory} />
          ))}
        </ul>
      )}
      {res.unavailable.map((u) => (
        <p key={`${u.kind}-${u.code}`} className="text-xs text-[var(--color-fg-muted)]">
          {`Not proposed (${safeText(u.kind, 40)}): ${safeText(u.reason, 300)}`}
        </p>
      ))}
    </section>
  );
}

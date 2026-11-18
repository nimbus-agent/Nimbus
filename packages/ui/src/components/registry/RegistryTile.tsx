import type { ReactNode } from "react";
import type { RegistryInfoResult, RegistryInfoVersion } from "../../ipc/types";
import { CopyMarkdownButton } from "../briefs/CopyMarkdownButton";
import { safeText, stamp } from "../incidents/safe";
import { installCommand, sponsorCommand } from "./commands";

function scoreText(v: RegistryInfoVersion | undefined): string {
  const q = v?.quality ?? null;
  if (q === null) return "not scored";
  return `${String(q.score)}/100 (${String(q.passed)} of ${String(q.cases)} cases passed)`;
}

function listText(xs: ReadonlyArray<string> | undefined): string {
  if (xs === undefined || xs.length === 0) return "none";
  return xs.map((x) => safeText(x, 120)).join(", ");
}

function CopyLine({ command }: { readonly command: string | null }): ReactNode {
  if (command === null) return null;
  return (
    <div className="flex items-center gap-2">
      <code className="font-mono text-xs">{command}</code>
      <CopyMarkdownButton text={command} label="Copy command" />
    </div>
  );
}

function Evidence({ info }: { readonly info: RegistryInfoResult }): ReactNode {
  const e = info.evidence;
  const rows: Array<[string, string]> = [
    ["Baseline", e.baseline.text],
    ["Tested", e.tested.text],
    ["History", e.history.text],
    ["Checked", e.checked.text],
  ];
  return (
    <dl data-testid="registry-evidence" className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
      {rows.map(([k, text]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--color-fg-muted)]">{k}</dt>
          <dd>{safeText(text, 400)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Permissions({ v }: { readonly v: RegistryInfoVersion | undefined }): ReactNode {
  const p = v?.permissions;
  const a = v?.access;
  return (
    <div data-testid="registry-permissions" className="text-sm flex flex-col gap-1">
      <p>{`Declared network: ${listText(p?.network)}`}</p>
      <p>{`Declared files: reads ${listText(p?.filesystem.read)}; writes ${listText(p?.filesystem.write)}`}</p>
      {a !== undefined && (
        <>
          <p>{`Network here: ${safeText(a.networkReach, 300)}`}</p>
          <p>{`Files here: ${safeText(a.fileAccess, 300)}`}</p>
          {a.canRunHere === false && (
            <p className="text-amber-700">The sandbox on this machine cannot run it.</p>
          )}
        </>
      )}
    </div>
  );
}

function Funding({ info }: { readonly info: RegistryInfoResult }): ReactNode {
  const links = info.funding ?? [];
  if (links.length === 0) return null;
  return (
    <div data-testid="registry-funding" className="text-sm flex flex-col gap-1">
      <p className="font-medium">Sponsor the author</p>
      {links.map((f) => {
        const url = safeText(f.url, 300);
        const label = f.label === undefined ? "" : `${safeText(f.label, 80)}: `;
        return (
          <div key={f.url} className="flex items-center gap-2">
            <span className="font-mono text-xs">{`${label}${url}`}</span>
            <CopyMarkdownButton text={f.url} label="Copy link" />
          </div>
        );
      })}
      <CopyLine command={sponsorCommand(info.id, info.registry)} />
    </div>
  );
}

/**
 * One extension as its registry's signed index describes it. Read-only: the tile installs, adds and
 * opens nothing. The owner copies the terminal command; the install prompt there is the approval.
 */
export function RegistryTile({
  info,
  name,
}: {
  readonly info: RegistryInfoResult;
  readonly name: string;
}): ReactNode {
  const newest = info.versions[0];
  const blockedVersions = info.versions.filter((v) => v.blocked).map((v) => v.version);
  return (
    <section data-testid="registry-tile" className="border rounded p-4 flex flex-col gap-3">
      <header>
        <h2 className="text-lg font-semibold">{safeText(name, 120)}</h2>
        <p className="font-mono text-xs">
          {`${safeText(info.id, 128)} · ${safeText(info.registry, 40)} · publisher ${safeText(info.publisherId, 64)}`}
        </p>
        {info.verifiedPublisher !== null && (
          <p className="text-sm">{`Verified publisher: @${safeText(info.verifiedPublisher.github, 40)}`}</p>
        )}
      </header>
      <p className="text-sm">
        {`Score: ${scoreText(newest)} · evidence for ${safeText(info.evidenceFor.version, 40)} (${safeText(info.evidenceFor.channel, 10)})`}
      </p>
      <Evidence info={info} />
      <Permissions v={newest} />
      {info.provenance !== null && (
        <p className="text-sm">
          {`Built from ${safeText(info.provenance.sourceRepository, 120)} at ${safeText(info.provenance.commit, 40)}`}
        </p>
      )}
      <p className="text-sm">{`License: ${info.license === null ? "not declared" : safeText(info.license, 60)}`}</p>
      {blockedVersions.length > 0 && (
        <p data-testid="registry-blocked" className="text-sm text-red-700">
          {`Blocked (revoked key or taken down), install refuses: ${blockedVersions.map((v) => safeText(v, 40)).join(", ")}`}
        </p>
      )}
      <ul className="text-xs text-[var(--color-fg-muted)]">
        {info.versions.map((v) => (
          <li key={v.version}>
            {`${safeText(v.version, 40)} (${safeText(v.channel, 10)}) published ${stamp(Date.parse(v.publishedAt))}`}
          </li>
        ))}
      </ul>
      <CopyLine command={installCommand(info.id, info.registry)} />
      <Funding info={info} />
    </section>
  );
}

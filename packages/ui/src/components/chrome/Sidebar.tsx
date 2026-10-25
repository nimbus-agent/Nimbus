import type { ReactNode } from "react";
import { useOncallBriefs } from "../../hooks/useOncallBriefs";
import { useRolePacks } from "../../hooks/useRolePacks";
import { useNimbusStore } from "../../store";
import { NavItem } from "./NavItem";

type Entry = { to: string; icon: string; label: string };

const BEFORE_BRIEFS: ReadonlyArray<Entry> = [{ to: "/", icon: "▦", label: "Dashboard" }];

const AFTER_BRIEFS: ReadonlyArray<Entry> = [
  { to: "/oncall", icon: "☎", label: "On-call" },
  { to: "/captures", icon: "✎", label: "Captures" },
  { to: "/hitl", icon: "⚠", label: "HITL" },
  { to: "/marketplace", icon: "⚙", label: "Marketplace" },
  { to: "/watchers", icon: "👁", label: "Watchers" },
  { to: "/workflows", icon: "▶", label: "Workflows" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

const BRIEFS_ENTRY: Entry = { to: "/briefs", icon: "📄", label: "Briefs" };

export function Sidebar(): ReactNode {
  const pendingHitl = useNimbusStore((s) => s.pendingHitl);
  const lastSeenPushedAt = useNimbusStore((s) => s.lastSeenPushedAt);
  const newest = useOncallBriefs().list?.briefs[0];
  const { sections } = useRolePacks();
  const oncallDot = newest !== undefined && newest.createdAt > lastSeenPushedAt;
  const renderEntry = (e: Entry): ReactNode => (
    <NavItem
      key={e.to}
      to={e.to}
      icon={e.icon}
      label={e.label}
      badge={e.to === "/hitl" ? pendingHitl : undefined}
      dot={e.to === "/oncall" ? oncallDot : undefined}
      dotLabel={e.to === "/oncall" ? "new pushed brief" : undefined}
    />
  );
  return (
    <nav
      aria-label="Primary"
      className="w-[150px] bg-[var(--color-bg)] border-r border-[var(--color-border)] py-2 flex flex-col overflow-y-auto"
    >
      {BEFORE_BRIEFS.map(renderEntry)}
      {renderEntry(BRIEFS_ENTRY)}
      {sections.map((s) => (
        // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border and legend styling the nav does not want
        <div key={s.id} role="group" aria-label={s.name}>
          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-[var(--color-fg-muted)] truncate">
            {s.name}
          </div>
          {s.agents.map((a) => (
            <NavItem key={a.name} to={`/briefs/${a.name}`} icon="•" label={a.displayName} />
          ))}
        </div>
      ))}
      {AFTER_BRIEFS.map(renderEntry)}
    </nav>
  );
}

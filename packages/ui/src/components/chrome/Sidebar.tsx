import type { ReactNode } from "react";
import { useOncallBriefs } from "../../hooks/useOncallBriefs";
import { useNimbusStore } from "../../store";
import { NavItem } from "./NavItem";

const ENTRIES: ReadonlyArray<{ to: string; icon: string; label: string }> = [
  { to: "/", icon: "▦", label: "Dashboard" },
  { to: "/oncall", icon: "☎", label: "On-call" },
  { to: "/hitl", icon: "⚠", label: "HITL" },
  { to: "/marketplace", icon: "⚙", label: "Marketplace" },
  { to: "/watchers", icon: "👁", label: "Watchers" },
  { to: "/workflows", icon: "▶", label: "Workflows" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

export function Sidebar(): ReactNode {
  const pendingHitl = useNimbusStore((s) => s.pendingHitl);
  const lastSeenPushedAt = useNimbusStore((s) => s.lastSeenPushedAt);
  const newest = useOncallBriefs().list?.briefs[0];
  const oncallDot = newest !== undefined && newest.createdAt > lastSeenPushedAt;
  return (
    <nav
      aria-label="Primary"
      className="w-[150px] bg-[var(--color-bg)] border-r border-[var(--color-border)] py-2 flex flex-col"
    >
      {ENTRIES.map((e) => (
        <NavItem
          key={e.to}
          to={e.to}
          icon={e.icon}
          label={e.label}
          badge={e.to === "/hitl" ? pendingHitl : undefined}
          dot={e.to === "/oncall" ? oncallDot : undefined}
          dotLabel={e.to === "/oncall" ? "new pushed brief" : undefined}
        />
      ))}
    </nav>
  );
}

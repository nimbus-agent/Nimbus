import type { ReactNode } from "react";
import { NavLink } from "react-router";

interface NavItemProps {
  readonly to: string;
  readonly icon: string;
  readonly label: string;
  readonly badge?: number | undefined;
  readonly dot?: boolean | undefined;
  readonly dotLabel?: string | undefined;
}

function formatBadge(n: number): string {
  return n > 9 ? "9+" : String(n);
}

function Indicator({
  badge,
  dot,
  dotLabel,
}: Pick<NavItemProps, "badge" | "dot" | "dotLabel">): ReactNode {
  if (badge !== undefined && badge > 0) {
    return (
      <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-accent)] text-white text-[10px]">
        {formatBadge(badge)}
      </span>
    );
  }
  if (dot === true) {
    return (
      <span
        data-testid="nav-dot"
        className="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)]"
      >
        <span className="sr-only">{dotLabel ?? "new"}</span>
      </span>
    );
  }
  return null;
}

export function NavItem({ to, icon, label, badge, dot, dotLabel }: NavItemProps): ReactNode {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex items-center gap-2 px-3 h-[44px] text-sm text-[var(--color-fg-muted)] hover:bg-white/5 ${
          isActive
            ? "bg-[rgba(120,144,255,0.15)] text-[var(--color-fg)] border-l-2 border-[var(--color-accent)]"
            : ""
        }`
      }
      end={to === "/"}
    >
      <span aria-hidden="true" className="w-4 text-center">
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      <Indicator badge={badge} dot={dot} dotLabel={dotLabel} />
    </NavLink>
  );
}

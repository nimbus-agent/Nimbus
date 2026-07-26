import type { ReactNode } from "react";
import { NavLink } from "react-router";

interface NavItemProps {
  readonly to: string;
  readonly icon: string;
  readonly label: string;
  readonly badge?: number | undefined;
}

function formatBadge(n: number): string {
  return n > 9 ? "9+" : String(n);
}

export function NavItem({ to, icon, label, badge }: NavItemProps): ReactNode {
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
      {badge !== undefined && badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full bg-[var(--color-accent)] text-white text-[10px]">
          {formatBadge(badge)}
        </span>
      )}
    </NavLink>
  );
}

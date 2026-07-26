import type { ReactNode } from "react";
import { NavLink } from "react-router";

interface SettingsEntry {
  readonly to: string;
  readonly label: string;
}

const ENTRIES: ReadonlyArray<SettingsEntry> = [
  { to: "/settings/model", label: "Model" },
  { to: "/settings/connectors", label: "Connectors" },
  { to: "/settings/profiles", label: "Profiles" },
  { to: "/settings/audit", label: "Audit" },
  { to: "/settings/data", label: "Data" },
  { to: "/settings/telemetry", label: "Telemetry" },
  { to: "/settings/updates", label: "Updates" },
];

export function SettingsSidebar(): ReactNode {
  return (
    <nav
      aria-label="Settings"
      className="w-[180px] bg-[var(--color-bg-subtle)] border-r border-[var(--color-border)] py-3 flex flex-col"
    >
      {ENTRIES.map((e) => (
        <NavLink
          key={e.to}
          to={e.to}
          className={({ isActive }) =>
            [
              "px-4 py-2 text-sm",
              isActive
                ? "font-semibold text-[var(--color-text)] bg-[var(--color-bg)] border-l-2 border-[var(--color-accent)]"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
            ].join(" ")
          }
        >
          {e.label}
        </NavLink>
      ))}
    </nav>
  );
}

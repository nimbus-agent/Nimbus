import type { ReactNode } from "react";
import { Outlet } from "react-router";
import { SettingsSidebar } from "../components/settings/SettingsSidebar";

export function Settings(): ReactNode {
  return (
    <div className="flex h-full min-h-0">
      <SettingsSidebar />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

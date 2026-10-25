import type { ReactNode } from "react";
import { PageHeader } from "../components/chrome/PageHeader";
import { AuditFeed } from "../components/dashboard/AuditFeed";
import { ConnectorGrid } from "../components/dashboard/ConnectorGrid";
import { IndexMetricsStrip } from "../components/dashboard/IndexMetricsStrip";
import { PackSections } from "../components/home/PackSections";
import { TryRolePackCard } from "../components/home/TryRolePackCard";

export function Dashboard(): ReactNode {
  return (
    <>
      <PageHeader title="Dashboard" />
      <div className="p-6 space-y-6">
        <TryRolePackCard />
        <PackSections />
        <IndexMetricsStrip />
        <ConnectorGrid />
        <AuditFeed />
      </div>
    </>
  );
}

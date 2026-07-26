import type { ReactNode } from "react";
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Route,
  RouterProvider,
} from "react-router";
import { RootLayout } from "./layouts/RootLayout";
import { Dashboard } from "./pages/Dashboard";
import { HitlPopup } from "./pages/HitlPopup";
import { Marketplace } from "./pages/Marketplace";
import { Onboarding } from "./pages/Onboarding";
import { Connect } from "./pages/onboarding/Connect";
import { Syncing } from "./pages/onboarding/Syncing";
import { Welcome } from "./pages/onboarding/Welcome";
import { QuickQuery } from "./pages/QuickQuery";
import { Settings } from "./pages/Settings";
import { AuditPanel } from "./pages/settings/AuditPanel";
import { ConnectorsPanel } from "./pages/settings/ConnectorsPanel";
import { DataPanel } from "./pages/settings/DataPanel";
import { ModelPanel } from "./pages/settings/ModelPanel";
import { ProfilesPanel } from "./pages/settings/ProfilesPanel";
import { TelemetryPanel } from "./pages/settings/TelemetryPanel";
import { UpdatesPanel } from "./pages/settings/UpdatesPanel";
import { HitlStub } from "./pages/stubs/HitlStub";
import { Watchers } from "./pages/Watchers";
import { Workflows } from "./pages/Workflows";
import { GatewayConnectionProvider } from "./providers/GatewayConnectionProvider";

function Wrapper({ children }: { readonly children: ReactNode }) {
  return <GatewayConnectionProvider>{children}</GatewayConnectionProvider>;
}

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route
      element={
        <Wrapper>
          <RootLayout />
        </Wrapper>
      }
    >
      <Route index element={<Dashboard />} />
      <Route path="onboarding" element={<Onboarding />}>
        <Route index element={<Navigate to="welcome" replace />} />
        <Route path="welcome" element={<Welcome />} />
        <Route path="connect" element={<Connect />} />
        <Route path="syncing" element={<Syncing />} />
      </Route>
      <Route path="quick" element={<QuickQuery />} />
      <Route path="hitl-popup" element={<HitlPopup />} />
      <Route path="hitl" element={<HitlStub />} />
      <Route path="settings" element={<Settings />}>
        <Route index element={<Navigate to="model" replace />} />
        <Route path="model" element={<ModelPanel />} />
        <Route path="connectors" element={<ConnectorsPanel />} />
        <Route path="profiles" element={<ProfilesPanel />} />
        <Route path="audit" element={<AuditPanel />} />
        <Route path="data" element={<DataPanel />} />
        <Route path="telemetry" element={<TelemetryPanel />} />
        <Route path="updates" element={<UpdatesPanel />} />
      </Route>
      <Route path="marketplace" element={<Marketplace />} />
      <Route path="watchers" element={<Watchers />} />
      <Route path="workflows" element={<Workflows />} />
    </Route>,
  ),
);

export function App() {
  return <RouterProvider router={router} />;
}

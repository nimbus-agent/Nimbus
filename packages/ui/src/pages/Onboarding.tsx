import { Outlet, useLocation } from "react-router";
import { useNimbusStore } from "../store";

type Step = { readonly path: string; readonly label: string };

/**
 * The header's steps for where the user is: the Pack step only while a pack is being set up, and
 * the last step is Decisions or Syncing — whichever route this onboarding ends on.
 */
export function onboardingSteps(pathname: string, packChosen: boolean): readonly Step[] {
  const last: Step = pathname.endsWith("/decisions")
    ? { path: "decisions", label: "Decisions" }
    : { path: "syncing", label: "Syncing" };
  return [
    { path: "welcome", label: "Welcome" },
    { path: "role", label: "Role" },
    ...(packChosen || pathname.endsWith("/pack") ? [{ path: "pack", label: "Pack" }] : []),
    { path: "connect", label: "Connect" },
    last,
  ];
}

export function Onboarding() {
  const { pathname } = useLocation();
  const packChosen = useNimbusStore((s) => s.chosenPackId !== null);
  const steps = onboardingSteps(pathname, packChosen);
  const currentIdx = steps.findIndex((s) => pathname.endsWith(`/${s.path}`));
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "48px 24px" }}>
      <div
        style={{
          width: "100%",
          maxWidth: 840,
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: 6, padding: "18px 24px 4px" }}>
          {steps.map((s, i) => {
            let state: "done" | "active" | "pending";
            if (i < currentIdx) state = "done";
            else if (i === currentIdx) state = "active";
            else state = "pending";

            const bgMap = {
              active: "rgba(120, 144, 255, 0.25)",
              done: "rgba(82, 196, 26, 0.2)",
              pending: "rgba(255, 255, 255, 0.05)",
            };
            const bg = bgMap[state];
            const color = state === "pending" ? "var(--color-fg-muted)" : "var(--color-fg)";
            return (
              <div
                key={s.path}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  background: bg,
                  color,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                }}
              >
                {i + 1} · {s.label}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "28px 32px", minHeight: 280 }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

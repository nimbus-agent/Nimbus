import type { ReactNode } from "react";
import { useRolePacks } from "../../hooks/useRolePacks";
import { AgentCard } from "./AgentCard";

export function PackSections(): ReactNode {
  const { sections, loaded } = useRolePacks();
  if (!loaded) return null;
  if (sections.length === 0) {
    return (
      <p className="text-sm text-[var(--color-fg-muted)]">
        Role packs tailor this screen — see nimbus pack list.
      </p>
    );
  }
  return (
    <>
      {sections.map((s) => (
        <section key={s.id} className="space-y-3">
          <h2 className="text-lg font-semibold">{s.name}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {s.agents.map((a) => (
              <AgentCard key={a.name} agent={a} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

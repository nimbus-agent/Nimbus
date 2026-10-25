import type { ReactNode } from "react";
import { Link } from "react-router";
import { CATEGORY_ORDER } from "../briefs/brief-form";
import { DESKTOP_EXCLUDED_AGENTS } from "../briefs/pack-sections";
import { PageHeader } from "../components/chrome/PageHeader";
import { useRolePacks } from "../hooks/useRolePacks";

const CATEGORY_LABEL: Readonly<Record<(typeof CATEGORY_ORDER)[number], string>> = {
  "catch-up": "Catch-up",
  knowledge: "Knowledge",
  people: "People",
  code: "Code",
  operations: "Operations",
};

export function Briefs(): ReactNode {
  const { catalog, catalogError } = useRolePacks();
  const agents = (catalog?.agents ?? []).filter((a) => !DESKTOP_EXCLUDED_AGENTS.has(a.name));
  return (
    <>
      <PageHeader title="Briefs" />
      <div className="p-6 space-y-6">
        {catalog === null &&
          (catalogError === null ? (
            <p className="text-sm">Loading…</p>
          ) : (
            <p role="alert" className="text-sm text-[var(--color-error)]">
              {`Could not load the brief list: ${catalogError}`}
            </p>
          ))}
        {CATEGORY_ORDER.map((cat) => {
          const inCat = agents.filter((a) => a.category === cat);
          if (inCat.length === 0) return null;
          return (
            <section key={cat} aria-label={CATEGORY_LABEL[cat]}>
              <h2 className="text-sm font-medium mb-2">{CATEGORY_LABEL[cat]}</h2>
              <ul className="space-y-1">
                {inCat.map((a) => (
                  <li key={a.name}>
                    <Link to={`/briefs/${a.name}`} className="font-medium">
                      {a.displayName}
                    </Link>
                    <span className="text-sm text-[var(--color-fg-muted)]">
                      {" — "}
                      {a.description}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}

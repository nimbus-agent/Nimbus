import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useRolePacks } from "../../hooks/useRolePacks";
import { createIpcClient } from "../../ipc/client";
import type { DiagSnapshot } from "../../ipc/types";
import { packRows } from "../../onboarding/role-choices";
import { useNimbusStore } from "../../store";

const DISMISSED_KEY = "role_pack_card_dismissed";

/**
 * For an install that predates role packs (or skipped them): a quiet card offering the packs,
 * shown once until dismissed. Never on a fresh install (onboarding asks there), never once any
 * pack is installed, never when the pack list could not be read.
 */
export function TryRolePackCard(): ReactNode {
  const navigate = useNavigate();
  const { packs, packError } = useRolePacks();
  const setChosenPack = useNimbusStore((s) => s.setChosenPack);
  const [eligible, setEligible] = useState(false);

  useEffect(() => {
    let live = true;
    const client = createIpcClient();
    void Promise.all([
      client.call<string | null>("db.getMeta", { key: DISMISSED_KEY }),
      client.call<string | null>("db.getMeta", { key: "onboarding_completed" }),
      client.call<DiagSnapshot>("diag.snapshot"),
    ])
      .then(([dismissed, completed, snap]) => {
        if (!live) return;
        const established = completed !== null || (snap?.indexTotalItems ?? 0) > 0;
        setEligible(dismissed === null && established);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (!eligible || packs === null || packError !== null || packs.installed.length > 0) return null;
  const available = packRows(packs).filter((p) => !p.installed);
  if (available.length === 0) return null;

  const dismiss = (): void => {
    setEligible(false);
    void createIpcClient()
      .call("db.setMeta", { key: DISMISSED_KEY, value: new Date().toISOString() })
      .catch(() => undefined);
  };

  return (
    <section
      aria-label="Try a role pack"
      className="border border-[var(--color-border)] rounded p-4 space-y-3"
    >
      <p className="text-sm">Nimbus can set itself up for your role.</p>
      <div className="flex flex-wrap gap-2">
        {available.map((p) => (
          <button
            key={p.id}
            type="button"
            className="px-3 py-1 border border-[var(--color-border)] rounded text-sm text-left"
            onClick={() => {
              setChosenPack(p.id);
              void navigate("/onboarding/pack");
            }}
          >
            <span className="font-medium">{p.name}</span>
            {p.description !== undefined && (
              <span className="block text-xs text-[var(--color-fg-muted)]">{p.description}</span>
            )}
          </button>
        ))}
      </div>
      <button type="button" className="text-xs text-[var(--color-fg-muted)]" onClick={dismiss}>
        Not now
      </button>
    </section>
  );
}

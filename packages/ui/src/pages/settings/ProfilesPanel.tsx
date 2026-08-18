import { useCallback, useEffect, useState } from "react";
import { PanelError } from "../../components/settings/PanelError";
import { PanelHeader } from "../../components/settings/PanelHeader";
import { StaleChip } from "../../components/settings/StaleChip";
import { useConfirm } from "../../hooks/useConfirm";
import { createIpcClient } from "../../ipc/client";
import type { ProfileListResult, ProfileSummary } from "../../ipc/types";
import { useNimbusStore } from "../../store";

export function ProfilesPanel() {
  const profiles = useNimbusStore((s) => s.profiles);
  const active = useNimbusStore((s) => s.active);
  const actionInFlight = useNimbusStore((s) => s.actionInFlight);
  const connectionState = useNimbusStore((s) => s.connectionState);
  const setProfileList = useNimbusStore((s) => s.setProfileList);
  const setProfileActionInFlight = useNimbusStore((s) => s.setProfileActionInFlight);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const confirm = useConfirm();

  const offline = connectionState === "disconnected";
  const writeDisabled = offline || actionInFlight;

  const refresh = useCallback(async () => {
    try {
      const res: ProfileListResult = await createIpcClient().profileList();
      setProfileList(res);
      setFetchError(null);
    } catch (e) {
      setFetchError((e as Error).message);
    }
  }, [setProfileList]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const onCreate = useCallback(async () => {
    if (newName.trim() === "") return;
    setProfileActionInFlight(true);
    try {
      await createIpcClient().profileCreate(newName.trim());
      setCreateOpen(false);
      setNewName("");
      await refresh();
    } finally {
      setProfileActionInFlight(false);
    }
  }, [newName, refresh, setProfileActionInFlight]);

  const onSwitch = useCallback(
    async (name: string) => {
      if (name === active) return;
      setProfileActionInFlight(true);
      setSwitchNotice(null);
      try {
        await createIpcClient().profileSwitch(name);
        // Re-read the list, exactly as onCreate/onDelete do. Without this the `active` marker
        // stays on the OLD row while the notice below says the switch succeeded — two
        // contradictory statements on screen at once. The server is the source of truth for
        // which profile is active, so this refetches rather than setting it optimistically.
        await refresh();
        // Switching a profile only updates the on-disk marker: NIMBUS_PROFILE is read at spawn
        // (cli/src/lib/spawn-gateway.ts), so the switch takes effect on the next Gateway start,
        // not this one. The CLI already prints this (cli/src/commands/profile.ts); mirror it here.
        setSwitchNotice(
          "Active profile set. Restart the Gateway for it to take effect (nimbus stop && nimbus start).",
        );
      } finally {
        setProfileActionInFlight(false);
      }
    },
    [active, refresh, setProfileActionInFlight],
  );

  const onDelete = useCallback(
    async (name: string) => {
      const ok = await confirm({
        title: `Delete profile "${name}"`,
        description: `This cannot be undone. Type "${name}" to confirm.`,
        expectedText: name,
        confirmLabel: "Delete",
      });
      if (!ok) return;
      setProfileActionInFlight(true);
      try {
        await createIpcClient().profileDelete(name);
        await refresh();
      } finally {
        setProfileActionInFlight(false);
      }
    },
    [confirm, refresh, setProfileActionInFlight],
  );

  return (
    <section className="p-6 space-y-6">
      <PanelHeader
        title="Profiles"
        description="Named configurations — switch to change which Vault namespace Nimbus reads from."
        livePill={offline ? <StaleChip /> : undefined}
      />
      {fetchError !== null && (
        <PanelError message={`Failed to load profiles: ${fetchError}`} onRetry={refresh} />
      )}
      {switchNotice !== null && (
        <div
          role="status"
          className="p-3 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
        >
          <p className="text-sm">{switchNotice}</p>
        </div>
      )}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={writeDisabled}
          className="px-3 py-1 rounded border border-[var(--color-border)] disabled:opacity-50"
        >
          Create…
        </button>
      </div>
      <ul className="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded-md">
        {profiles.map((p: ProfileSummary) => (
          <li
            key={p.name}
            data-testid="profile-row"
            className="flex items-center justify-between px-4 py-3"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{p.name}</span>
              {p.name === active && (
                <span className="text-xs rounded-full px-2 py-0.5 bg-[var(--color-accent-bg)] text-[var(--color-accent)]">
                  active
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                aria-label={`Switch to ${p.name}`}
                onClick={() => onSwitch(p.name)}
                disabled={writeDisabled || p.name === active}
                className="px-2 py-1 text-sm rounded border border-[var(--color-border)] disabled:opacity-50"
              >
                Switch
              </button>
              <button
                type="button"
                aria-label={`Delete ${p.name}`}
                onClick={() => onDelete(p.name)}
                disabled={writeDisabled || p.name === active}
                className="px-2 py-1 text-sm rounded border border-[var(--color-danger-border)] text-[var(--color-danger-text)] disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {createOpen && (
        <dialog
          open
          aria-label="Create profile"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
        >
          <div className="bg-[var(--color-bg)] rounded-md p-6 w-[420px] border border-[var(--color-border)]">
            <h3 className="text-lg font-semibold mb-2">Create profile</h3>
            <label className="text-sm block mb-2" htmlFor="new-profile-name">
              Profile name
            </label>
            <input
              id="new-profile-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-[var(--color-bg-subtle)] mb-4"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCreateOpen(false);
                  setNewName("");
                }}
                className="px-3 py-1 rounded border border-[var(--color-border)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onCreate}
                disabled={newName.trim() === "" || actionInFlight}
                className="px-3 py-1 rounded bg-[var(--color-accent)] text-white disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </dialog>
      )}
      {confirm.modal}
    </section>
  );
}

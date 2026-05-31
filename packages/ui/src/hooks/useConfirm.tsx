import { type ReactNode, useCallback, useState } from "react";

export interface ConfirmOptions {
  readonly title: string;
  readonly description: string;
  readonly expectedText?: string;
  readonly confirmLabel: string;
}

interface InternalState {
  readonly options: ConfirmOptions;
  readonly resolve: (result: boolean) => void;
}

export function useConfirm(): ((options: ConfirmOptions) => Promise<boolean>) & {
  modal: ReactNode;
} {
  const [state, setState] = useState<InternalState | null>(null);
  const [typed, setTyped] = useState("");

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped("");
        setState({ options, resolve });
      }),
    [],
  );

  const close = useCallback(
    (result: boolean) => {
      if (state !== null) state.resolve(result);
      setState(null);
      setTyped("");
    },
    [state],
  );

  const match = state?.options.expectedText;
  const canConfirm = match === undefined || typed === match;

  const modal: ReactNode =
    state === null ? null : (
      <dialog
        open
        aria-modal="true"
        aria-label={state.options.title}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 border-0 max-w-none w-full h-full m-0 p-0"
      >
        <div className="bg-[var(--color-bg)] rounded-md p-6 w-[420px] max-w-[90vw] border border-[var(--color-border)]">
          <h3 className="text-lg font-semibold mb-2">{state.options.title}</h3>
          <p className="text-sm text-[var(--color-text-muted)] mb-4">{state.options.description}</p>
          {match !== undefined && (
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label="confirmation"
              className="w-full px-3 py-2 rounded border border-[var(--color-border)] mb-4 bg-[var(--color-bg-subtle)]"
            />
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => close(false)}
              className="px-3 py-1 rounded border border-[var(--color-border)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => close(true)}
              disabled={!canConfirm}
              className="px-3 py-1 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] disabled:opacity-50"
            >
              {state.options.confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    );

  return Object.assign(confirm, { modal });
}

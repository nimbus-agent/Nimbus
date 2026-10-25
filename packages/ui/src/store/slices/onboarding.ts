import type { StateCreator } from "zustand";

export type AuthStatus = "pending" | "authenticating" | "connected" | "cancelled" | "failed";

export interface OnboardingSlice {
  readonly selected: ReadonlySet<string>;
  readonly authStatus: Readonly<Record<string, AuthStatus>>;
  /** The role pack the Role step chose (a `pack.list` id), or null for a non-pack answer. */
  readonly chosenPackId: string | null;
  setChosenPack: (id: string | null) => void;
  toggleSelected: (name: string) => void;
  setAuthStatus: (name: string, status: AuthStatus) => void;
  resetOnboarding: () => void;
}

export const createOnboardingSlice: StateCreator<OnboardingSlice, [], [], OnboardingSlice> = (
  set,
) => ({
  selected: new Set<string>(),
  authStatus: {},
  chosenPackId: null,
  setChosenPack: (id) => set({ chosenPackId: id }),
  toggleSelected: (name) =>
    set((state) => {
      const next = new Set(state.selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { selected: next };
    }),
  setAuthStatus: (name, status) =>
    set((state) => ({ authStatus: { ...state.authStatus, [name]: status } })),
  resetOnboarding: () => set({ selected: new Set<string>(), authStatus: {}, chosenPackId: null }),
});

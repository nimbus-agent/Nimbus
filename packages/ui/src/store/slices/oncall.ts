import type { StateCreator } from "zustand";

export interface OncallSlice {
  /** The newest pushed brief's `createdAt` the owner has seen on /oncall. Drives the sidebar dot. */
  readonly lastSeenPushedAt: number;
  markPushedSeen: (createdAt: number) => void;
}

export const createOncallSlice: StateCreator<OncallSlice, [], [], OncallSlice> = (set) => ({
  lastSeenPushedAt: 0,
  // Forward-only: a stale list (or a bad value) can never re-light the dot for something seen.
  markPushedSeen: (createdAt) =>
    set((s) =>
      Number.isFinite(createdAt) && createdAt > s.lastSeenPushedAt
        ? { lastSeenPushedAt: createdAt }
        : {},
    ),
});

/**
 * Live registry of the gateway's own listening sockets, for the "wow" locality panel — it shows
 * the owner which listeners are open RIGHT NOW and whether each is loopback. That panel is only
 * honest if a listener that is not actually open is absent, never reported "closed": `live()`
 * calls each registered PROBE fresh on every read, so it can never report a stale snapshot.
 *
 * Each of the five listen sites (`ipc`, `http`, `lan`, `metrics`, `oauth_callback`) registers a
 * probe right after its own `listen`/`serve` call succeeds and unregisters on every stop path
 * (success, error, and — for `oauth_callback` — timeout). A probe returning `null` means "not
 * listening right now" without the caller having to remember to unregister eagerly; `live()` also
 * treats a THROWING probe as `null` rather than letting one broken site crash the whole panel.
 */

export type ListenerName = "ipc" | "http" | "lan" | "metrics" | "oauth_callback";

export interface ListenerReport {
  readonly name: ListenerName;
  readonly address: string;
  readonly loopback: boolean;
}

export interface ListenerRegistry {
  /** Returns the unregister function. `probe` returning null means "not listening right now". */
  register(probe: () => ListenerReport | null): () => void;
  live(): ListenerReport[];
}

function compareReports(a: ListenerReport, b: ListenerReport): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return 0;
}

export function createListenerRegistry(): ListenerRegistry {
  const probes = new Set<() => ListenerReport | null>();
  return {
    register(probe: () => ListenerReport | null): () => void {
      probes.add(probe);
      return (): void => {
        probes.delete(probe);
      };
    },
    live(): ListenerReport[] {
      const out: ListenerReport[] = [];
      for (const probe of probes) {
        let report: ListenerReport | null;
        try {
          report = probe();
        } catch {
          report = null;
        }
        if (report !== null) out.push(report);
      }
      return out.sort(compareReports);
    },
  };
}

/** The one registry every real listen site registers with — see the module doc above. */
export const processListeners: ListenerRegistry = createListenerRegistry();

export function registerListener(probe: () => ListenerReport | null): () => void {
  return processListeners.register(probe);
}

/**
 * In-memory, process-lifetime consent decisions for non-standing grants. Never persisted.
 * Nested map (namespace -> peerId -> decision): no string delimiter, so zero collision risk
 * between a peerId and a namespace, and invalidateNamespace is O(1).
 */
export class SessionConsentCache {
  private readonly byNamespace = new Map<string, Map<string, boolean>>();

  get(peerId: string, namespace: string): boolean | undefined {
    return this.byNamespace.get(namespace)?.get(peerId);
  }

  set(peerId: string, namespace: string, approved: boolean): void {
    let inner = this.byNamespace.get(namespace);
    if (inner === undefined) {
      inner = new Map<string, boolean>();
      this.byNamespace.set(namespace, inner);
    }
    inner.set(peerId, approved);
  }

  invalidate(peerId: string, namespace: string): void {
    this.byNamespace.get(namespace)?.delete(peerId);
  }

  invalidateNamespace(namespace: string): void {
    this.byNamespace.delete(namespace);
  }
}

/**
 * Test-only notification recorder. Connector-sync code does not emit
 * notifications directly (the scheduler does), so for Phase 2A this is
 * unused by slack-sync — but it is part of the harness contract so
 * future tests that exercise scheduler-level paths can assert on the
 * `connector.healthChanged` payloads emitted in response to RateLimitError /
 * UnauthenticatedError thrown by `sync()`.
 */
export class MockNotificationLog {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];

  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
  }

  clear(): void {
    this.emitted.length = 0;
  }

  /** Every emitted payload for a given topic (filter helper). */
  payloadsFor(topic: string): unknown[] {
    return this.emitted.filter((e) => e.topic === topic).map((e) => e.payload);
  }
}

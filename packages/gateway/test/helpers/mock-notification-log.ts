export class MockNotificationLog {
  readonly emitted: Array<{ topic: string; payload: unknown }> = [];

  emit(topic: string, payload: unknown): void {
    this.emitted.push({ topic, payload });
  }

  clear(): void {
    this.emitted.length = 0;
  }

  payloadsFor(topic: string): unknown[] {
    return this.emitted.filter((e) => e.topic === topic).map((e) => e.payload);
  }
}

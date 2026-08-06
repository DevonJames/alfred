import type { ConversationEvent } from "@alfred/contracts";

/** OpenTelemetry-compatible hook surface. M1 uses a no-op exporter. */
export interface SpanHandle {
  end(attributes?: Record<string, string | number | boolean>): void;
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(error: unknown): void;
}

export interface Observability {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): SpanHandle;
  emitEvent(event: ConversationEvent): void;
}

export class NoopObservability implements Observability {
  startSpan(): SpanHandle {
    return {
      end() {},
      setAttribute() {},
      recordException() {},
    };
  }
  emitEvent(): void {}
}

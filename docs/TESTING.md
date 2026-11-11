# Testing Strategy

## Local Unit & Integration

- **ManualTimers**: A deterministic timer scheduler simulating `setTimeout` and `clearTimeout`. Used to verify exponential backoff timing and jitter without real waiting.
- **FakeIdempotentServer**: An HTTP transport simulation that records the order of operations, enforces idempotency deduplication, and injects network faults (`503`, `429`, `400`, `409`) or network rejections.
- **fake-indexeddb**: Used in unit tests to verify persistent storage durability and reload scenarios.

## CI Conformance

- **Chromium Playwright Suite**: Located in `test/browser.conformance.test.ts`, this suite drives a real headless browser using `context.setOffline(true/false)` and interacts with a real local Node.js HTTP server to verify end-to-end operation delivery across reconnection events.
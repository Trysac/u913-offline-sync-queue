# Stack & Dependencies

## Runtime Dependencies

None. The library utilizes standard Web Platform APIs (`fetch`, `AbortController`, `TextEncoder`, `indexedDB`, `URL`) available in modern browsers and Node.js 22+.

## Development & Test Dependencies

- **`fake-indexeddb`**: Provides an in-memory IndexedDB implementation for testing persistence.
- **`playwright`**: Used for browser conformance testing in the CI environment.
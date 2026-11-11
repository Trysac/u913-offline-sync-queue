# Security & Threat Model

## Defended Threats

1. **Duplicate Mutation Application**: Every request includes an `Idempotency-Key` header (`<id>` or `<id>.r<n>`), allowing servers to deduplicate retried requests resulting from lost network responses.
2. **Resource Exhaustion**: `enqueue()` enforces strict limits: `maxOps` (10,000), `maxBodyBytes` (1,048,576), `id` (128 chars), `url` (2,048 chars), and JSON nesting depth (64).
3. **Sensitive Data Exposure**: `QueueEvent` objects emitted via `onEvent` never include request bodies, URLs, or headers. `SyncError` messages are truncated to 200 characters and exclude sensitive inputs.

## Not Defended

1. **Server Incompatibility**: The queue relies on the backend to enforce deduplication via `Idempotency-Key`. If the server ignores this header, duplicate applications will occur.
2. **Multi-Tab Concurrency**: Cross-tab coordination is not implemented. Multiple tabs sharing the same database rely solely on server-side deduplication.
3. **Local Tampering**: IndexedDB is not encrypted. Any script with access to the origin (e.g., via XSS) can manipulate queued operations.
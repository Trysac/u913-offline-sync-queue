# Architecture

## Overview

`@trysac/offline-sync-queue` is structured around small, deterministic interfaces with zero runtime dependencies and no Node-specific imports in `src/`, making it compatible with modern browsers, Service Workers, and Node.js 22+.

## Components

- **`src/types.ts`**: Public TypeScript interfaces (`Queue`, `Storage`, `Transport`, `OnlineSource`, `QueueEvent`, `DeadLetter`, etc.).
- **`src/errors.ts`**: `SyncError` with stable error codes (`queue_full`, `payload_too_large`, `duplicate_id`, `invalid_op`, `storage_failed`) and message length capping (200 chars max).
- **`src/storage.ts`**:
  - `MemoryStorage`: Map-backed storage sorted by monotonic sequence number `seq`.
  - `IndexedDbStorage`: Browser IndexedDB store persisting `StoredOp` records keyed by `id` and sorted on load by `seq`.
- **`src/transport.ts`**: Default `fetch`-based `Transport` adapter that maps HTTP responses and headers while propagating network failures as promise rejections.
- **`src/online.ts`**: `browserOnlineSource` for DOM `online`/`offline` events and `registerSyncHandler` for Service Worker Background Sync integration.
- **`src/queue.ts`**: Core state machine managing validation, persistence, single-flight FIFO flushing, jittered exponential backoff, `Retry-After` parsing, `409 Conflict` resolution, and bounded dead-letter eviction.

## State Machine & Ordering

1. **Validation Order on `enqueue`**:
   - Shape validation (`invalid_op`: `id` 1..128 trimmed characters, `method` in `POST | PUT | PATCH | DELETE`, `url` relative or HTTPS, JSON depth <= 64).
   - Payload size validation (`payload_too_large`: UTF-8 JSON byte length <= `maxBodyBytes`, default 1,048,576).
   - Duplicate ID check (`duplicate_id`).
   - Queue capacity check (`queue_full`: default 10,000).
2. **Single-Flight FIFO Flush**:
   - Concurrent calls to `flush()` share the same in-flight promise.
   - Only the head operation (lowest `seq`) is sent at any moment.
   - Operations are deleted from `Storage` only upon a terminal outcome (`2xx`, dead-letter, or conflict `drop`).

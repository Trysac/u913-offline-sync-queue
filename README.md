# @trysac/offline-sync-queue

Offline-first HTTP operation queue with IndexedDB persistence, stable idempotency keys, injectable exponential backoff, conflict resolution hooks, dead-letter tracking, and a Service Worker Background Sync adapter.

## The Problem

Web applications that must work offline often lose operations when a tab closes, duplicate requests when a response is lost, or cause server-side corruption by retrying in tight loops. @trysac/offline-sync-queue provides a robust, testable subsystem that guarantees effectively-once mutation application using persistent queues and stable idempotency keys.

## Installation

```bash
npm install @trysac/offline-sync-queue
```

## Usage

```ts
import { browserOnlineSource, createQueue, IndexedDbStorage } from "@trysac/offline-sync-queue";

const queue = createQueue({
  storage: new IndexedDbStorage("app-sync"),
  online: browserOnlineSource(),
});
queue.start();
await queue.enqueue({ id: "op-1", method: "POST", url: "/api/items", body: { title: "Buy milk" } });
```

## API Summary

- `createQueue(opts)`: Configures and returns a `Queue` instance.
- `MemoryStorage` / `IndexedDbStorage(dbName)`: Persistence adapters.
- `browserOnlineSource()`: Browser DOM event wrapper for connectivity.
- `registerSyncHandler(sw, queue)`: Binds Service Worker sync events.
- `SyncError`: Typed error class with codes (`queue_full`, `payload_too_large`, `duplicate_id`, `invalid_op`, `storage_failed`).

## Why not Workbox Background Sync?

While Workbox replays raw `Request` objects, @trysac/offline-sync-queue offers specific application-level primitives that raw replay lacks: explicit idempotency key lifecycle (key rotation on conflict), structured conflict resolution hooks (via `onConflict`), and bounded dead-letter inspection.

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and defense strategies.
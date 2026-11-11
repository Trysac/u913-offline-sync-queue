/**
 * Public entry point of `@trysac/offline-sync-queue`.
 *
 * Offline-first operation queue with IndexedDB storage, idempotency keys,
 * injectable backoff, conflict resolution, and a Service Worker Background Sync hook.
 */

export { SyncError, type SyncErrorCode } from "./errors.js";
export {
  browserOnlineSource,
  DEFAULT_SYNC_TAG,
  type OnlineEventTarget,
  registerSyncHandler,
  type SyncEventLike,
  type SyncServiceWorkerTarget,
} from "./online.js";
export { createQueue } from "./queue.js";
export { IndexedDbStorage, MemoryStorage } from "./storage.js";
export { createFetchTransport } from "./transport.js";
export type {
  Clock,
  ConflictHandler,
  ConflictResolution,
  DeadLetter,
  EnqueueOp,
  HttpMethod,
  OnlineSource,
  Queue,
  QueueEvent,
  QueueOptions,
  Storage,
  StoredOp,
  Timers,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./types.js";

/**
 * Supported HTTP mutation methods.
 */
export type HttpMethod = "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Operation input passed to `queue.enqueue(op)`.
 */
export interface EnqueueOp {
  readonly id: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly body?: unknown;
}

/**
 * Persisted representation of a queued operation.
 */
export interface StoredOp {
  readonly seq: number;
  readonly id: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly hasBody: boolean;
  readonly bodyJson?: string;
  readonly body?: unknown;
  readonly attempt: number;
  readonly conflictCount: number;
  readonly createdAt: number;
}

/**
 * Record of an operation that permanently failed.
 */
export interface DeadLetter {
  readonly op: EnqueueOp;
  readonly reason: string;
  readonly status?: number;
  readonly attempts: number;
  readonly failedAt: number;
}

/**
 * Pluggable persistence backend for queued operations.
 */
export interface Storage {
  /**
   * Loads all stored operations ordered by their `seq` ascending.
   */
  load(): Promise<StoredOp[]>;
  /**
   * Inserts or updates an operation in storage.
   */
  put(op: StoredOp): Promise<void>;
  /**
   * Deletes an operation by its `id`.
   */
  delete(id: string): Promise<void>;
}

/**
 * Outgoing HTTP request descriptor passed to a `Transport`.
 */
export interface TransportRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

/**
 * Incoming HTTP response descriptor returned by a `Transport`.
 */
export interface TransportResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
}

/**
 * Pluggable HTTP transport.
 */
export interface Transport {
  send(req: TransportRequest): Promise<TransportResponse>;
}

/**
 * Pluggable network connectivity monitor.
 */
export interface OnlineSource {
  isOnline(): boolean;
  subscribe(fn: (online: boolean) => void): () => void;
}

/**
 * Injectable clock interface.
 */
export interface Clock {
  now(): number;
}

/**
 * Injectable timer scheduler interface.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Conflict resolution outcome returned by `onConflict`.
 */
export type ConflictResolution =
  | { readonly action: "retry"; readonly body: unknown }
  | { readonly action: "drop" };

/**
 * Conflict handler invoked on HTTP 409 responses.
 */
export type ConflictHandler = (
  op: EnqueueOp,
  server: { readonly status: 409; readonly body: unknown },
) => ConflictResolution | Promise<ConflictResolution>;

/**
 * Telemetry event emitted by the queue. Never contains request bodies, URL queries, or headers.
 */
export interface QueueEvent {
  readonly type: "enqueued" | "sent" | "retry_scheduled" | "dead_letter" | "conflict";
  readonly opId: string;
  readonly attempt: number;
  readonly status?: number;
  readonly delayMs?: number;
  readonly reason?: string;
}

/**
 * Configuration options for `createQueue`.
 */
export interface QueueOptions {
  readonly storage: Storage;
  readonly transport?: Transport;
  readonly online: OnlineSource;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly maxAttempts?: number;
  readonly maxOps?: number;
  readonly maxBodyBytes?: number;
  readonly maxDeadLetters?: number;
  readonly onConflict?: ConflictHandler;
  readonly onEvent?: (event: QueueEvent) => void;
}

/**
 * Offline-first operation queue instance.
 */
export interface Queue {
  /**
   * Validates, persists, and schedules an operation for delivery.
   */
  enqueue(op: EnqueueOp): Promise<void>;
  /**
   * Flushes queued operations in strict FIFO order while online.
   * Single-flight: concurrent calls share the active flush run.
   */
  flush(): Promise<void>;
  /**
   * Returns the current number of pending operations in the queue.
   */
  size(): number;
  /**
   * Returns a snapshot of dead-lettered operations (oldest to newest, up to `maxDeadLetters`).
   */
  deadLetters(): DeadLetter[];
  /**
   * Subscribes to the online source and triggers `flush()` when online.
   */
  start(): void;
  /**
   * Unsubscribes from the online source, cancels pending retry timers, and aborts any in-flight request.
   */
  stop(): void;
}

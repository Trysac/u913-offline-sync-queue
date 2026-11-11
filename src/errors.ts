/**
 * Error codes emitted by `@trysac/offline-sync-queue`.
 */
export type SyncErrorCode =
  | "queue_full"
  | "payload_too_large"
  | "duplicate_id"
  | "invalid_op"
  | "storage_failed";

/**
 * Base error class for `@trysac/offline-sync-queue`.
 * Messages never contain secrets or more than 200 characters of untrusted input.
 */
export class SyncError extends Error {
  public readonly code: SyncErrorCode;

  public constructor(code: SyncErrorCode, message: string, options?: { cause?: unknown }) {
    const safeMessage = message.length > 200 ? `${message.slice(0, 197)}...` : message;
    super(safeMessage, options);
    this.name = "SyncError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

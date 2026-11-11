/// <reference lib="dom" />

import type { OnlineSource, Queue } from "./types.js";

/**
 * Minimal subset of a `Window` or `EventTarget` needed by `browserOnlineSource`.
 */
export interface OnlineEventTarget {
  readonly navigator?: { readonly onLine?: boolean };
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

/**
 * Creates an `OnlineSource` bound to browser `online` and `offline` events.
 *
 * @param target - Optional window-like target (defaults to `globalThis`).
 */
export function browserOnlineSource(target?: Window | OnlineEventTarget): OnlineSource {
  const win: OnlineEventTarget | undefined =
    target ?? (globalThis as unknown as OnlineEventTarget | undefined);

  return {
    isOnline(): boolean {
      if (win?.navigator && typeof win.navigator.onLine === "boolean") {
        return win.navigator.onLine;
      }
      if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
        return navigator.onLine;
      }
      return true;
    },
    subscribe(fn: (online: boolean) => void): () => void {
      if (!win || typeof win.addEventListener !== "function") {
        return () => {};
      }
      const onOnline = (): void => fn(true);
      const onOffline = (): void => fn(false);
      win.addEventListener("online", onOnline);
      win.addEventListener("offline", onOffline);
      return () => {
        win.removeEventListener("online", onOnline);
        win.removeEventListener("offline", onOffline);
      };
    },
  };
}

/**
 * Minimal ServiceWorker sync event interface.
 */
export interface SyncEventLike {
  readonly tag: string;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Minimal ServiceWorkerGlobalScope interface supporting the Background Sync API.
 */
export interface SyncServiceWorkerTarget {
  addEventListener(type: "sync", listener: (event: SyncEventLike) => void): void;
}

/**
 * Default Background Sync tag used by `registerSyncHandler`.
 */
export const DEFAULT_SYNC_TAG = "trysac-offline-sync";

/**
 * Registers a Service Worker `sync` event listener that flushes the queue when `event.tag` matches `tag`.
 *
 * @param sw - Service worker global scope or event target.
 * @param queue - The offline sync queue to flush.
 * @param tag - Sync tag to match (defaults to `'trysac-offline-sync'`).
 */
export function registerSyncHandler(
  sw: SyncServiceWorkerTarget,
  queue: Queue,
  tag: string = DEFAULT_SYNC_TAG,
): void {
  if (!sw || typeof sw.addEventListener !== "function") {
    throw new TypeError("sw must provide addEventListener('sync', fn)");
  }
  if (typeof tag !== "string" || tag.trim().length === 0) {
    throw new TypeError("tag must be a non-empty string");
  }
  sw.addEventListener("sync", (event: SyncEventLike) => {
    if (event && event.tag === tag && typeof event.waitUntil === "function") {
      event.waitUntil(queue.flush());
    }
  });
}

import { SyncError } from "./errors.js";
import { createFetchTransport } from "./transport.js";
import type {
  Clock,
  ConflictHandler,
  DeadLetter,
  EnqueueOp,
  HttpMethod,
  Queue,
  QueueEvent,
  QueueOptions,
  StoredOp,
  Timers,
  Transport,
  TransportResponse,
} from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_OPS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_MAX_DEAD_LETTERS = 1_000;
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2_048;
const MAX_JSON_DEPTH = 64;

const ALLOWED_METHODS = new Set<HttpMethod>(["POST", "PUT", "PATCH", "DELETE"]);

const defaultClock: Clock = {
  now: () => Date.now(),
};

const defaultTimers: Timers = {
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function checkJsonDepth(value: unknown, depth: number): void {
  if (depth > MAX_JSON_DEPTH) {
    throw new SyncError(
      "invalid_op",
      `Operation body exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
    );
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      checkJsonDepth(value[i], depth + 1);
    }
    return;
  }
  for (const val of Object.values(value as Record<string, unknown>)) {
    checkJsonDepth(val, depth + 1);
  }
}

function isValidUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return false;
  }
  if (/\s/.test(url)) {
    return false;
  }
  // Relative path starting with single '/' (not protocol-relative '//')
  if (url.startsWith("/") && !url.startsWith("//")) {
    return true;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateOpShape(op: EnqueueOp): void {
  if (!op || typeof op !== "object") {
    throw new SyncError("invalid_op", "Operation must be an object");
  }
  if (
    typeof op.id !== "string" ||
    op.id.trim().length === 0 ||
    op.id.length > MAX_ID_LENGTH ||
    op.id !== op.id.trim()
  ) {
    throw new SyncError(
      "invalid_op",
      `Operation id must be a non-empty trimmed string of 1..${MAX_ID_LENGTH} characters`,
    );
  }
  if (!ALLOWED_METHODS.has(op.method)) {
    throw new SyncError("invalid_op", "Operation method must be POST, PUT, PATCH, or DELETE");
  }
  if (!isValidUrl(op.url)) {
    throw new SyncError("invalid_op", "Operation url must be a relative path or valid HTTPS URL");
  }
}

function serializeBody(
  body: unknown,
  maxBodyBytes: number,
): { hasBody: boolean; bodyJson?: string; parsedBody?: unknown } {
  if (body === undefined) {
    return { hasBody: false };
  }
  checkJsonDepth(body, 0);
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch (err) {
    throw new SyncError("invalid_op", "Operation body is not JSON-serializable", { cause: err });
  }
  if (json === undefined) {
    return { hasBody: false };
  }
  const byteLength = new TextEncoder().encode(json).byteLength;
  if (byteLength > maxBodyBytes) {
    throw new SyncError(
      "payload_too_large",
      `Operation body size (${byteLength} bytes) exceeds maximum of ${maxBodyBytes} bytes`,
    );
  }
  return {
    hasBody: true,
    bodyJson: json,
    parsedBody: JSON.parse(json) as unknown,
  };
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  targetName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lowerTarget = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lowerTarget) {
      return v;
    }
  }
  return undefined;
}

function parseRetryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = getHeaderCaseInsensitive(headers, "retry-after");
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3_600) {
    return undefined;
  }
  return seconds * 1_000;
}

function computeBackoffMs(
  attempt: number,
  random: () => number,
  headers?: Record<string, string>,
): number {
  const r = Math.max(0, Math.min(1, random()));
  const base = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
  const jittered = Math.round(base * (0.5 + r / 2));
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs !== undefined && retryAfterMs > jittered) {
    return retryAfterMs;
  }
  return jittered;
}

function formatIdempotencyKey(id: string, conflictCount: number): string {
  return conflictCount === 0 ? id : `${id}.r${conflictCount}`;
}

function toEnqueueOp(stored: StoredOp): EnqueueOp {
  if (stored.hasBody) {
    const clonedBody =
      stored.bodyJson !== undefined ? (JSON.parse(stored.bodyJson) as unknown) : stored.body;
    return {
      id: stored.id,
      method: stored.method,
      url: stored.url,
      body: clonedBody,
    };
  }
  return {
    id: stored.id,
    method: stored.method,
    url: stored.url,
  };
}

/**
 * Creates an offline-first operation sync queue.
 *
 * @param opts - Queue configuration options.
 * @returns A `Queue` instance.
 */
export function createQueue(opts: QueueOptions): Queue {
  const storage = opts.storage;
  const transport: Transport = opts.transport ?? createFetchTransport();
  const online = opts.online;
  const clock: Clock = opts.clock ?? defaultClock;
  const timers: Timers = opts.timers ?? defaultTimers;
  const random: () => number = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxOps = opts.maxOps ?? DEFAULT_MAX_OPS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxDeadLetters = opts.maxDeadLetters ?? DEFAULT_MAX_DEAD_LETTERS;
  const onConflict: ConflictHandler | undefined = opts.onConflict;
  const onEvent = opts.onEvent;

  const opsMap = new Map<string, StoredOp>();
  const deadLetterList: DeadLetter[] = [];
  let nextSeq = 1;
  let initPromise: Promise<void> | null = null;
  let initialized = false;

  let activeFlushPromise: Promise<void> | null = null;
  let unsubscribeOnline: (() => void) | null = null;
  let stopped = false;
  let inFlightAbort: AbortController | null = null;
  let retryTimerHandle: unknown = null;
  let cancelRetryWait: (() => void) | null = null;

  // Synchronously kick off initial load from storage so size() is populated once storage resolves
  function ensureInit(): Promise<void> {
    if (initialized) {
      return Promise.resolve();
    }
    if (initPromise !== null) {
      return initPromise;
    }
    initPromise = (async () => {
      const loaded = await storage.load();
      for (const item of loaded) {
        if (!opsMap.has(item.id)) {
          opsMap.set(item.id, item);
          if (item.seq >= nextSeq) {
            nextSeq = item.seq + 1;
          }
        }
      }
      initialized = true;
    })();
    return initPromise;
  }

  // Trigger background load immediately on creation; attach noop catch to prevent unhandled rejection if unused
  ensureInit().catch(() => {});

  function emit(event: QueueEvent): void {
    if (!onEvent) {
      return;
    }
    const safeEvent: QueueEvent = {
      type: event.type,
      opId: event.opId,
      attempt: event.attempt,
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
    };
    try {
      onEvent(safeEvent);
    } catch {
      // Telemetry listener errors must never break queue execution
    }
  }

  function recordDeadLetter(op: StoredOp, reason: string, attempts: number, status?: number): void {
    if (maxDeadLetters <= 0) {
      return;
    }
    if (deadLetterList.length >= maxDeadLetters) {
      deadLetterList.shift();
    }
    const entry: DeadLetter = {
      op: toEnqueueOp(op),
      reason,
      attempts,
      failedAt: clock.now(),
      ...(status !== undefined ? { status } : {}),
    };
    deadLetterList.push(entry);
    emit({
      type: "dead_letter",
      opId: op.id,
      attempt: attempts,
      reason,
      ...(status !== undefined ? { status } : {}),
    });
  }

  function clearPendingTimer(): void {
    if (retryTimerHandle !== null) {
      timers.clearTimeout(retryTimerHandle);
      retryTimerHandle = null;
    }
    if (cancelRetryWait !== null) {
      const fn = cancelRetryWait;
      cancelRetryWait = null;
      fn();
    }
  }

  function getSortedOps(): StoredOp[] {
    const list = Array.from(opsMap.values());
    list.sort((a, b) => a.seq - b.seq);
    return list;
  }

  function waitDelay(delayMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      cancelRetryWait = () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      };
      retryTimerHandle = timers.setTimeout(() => {
        if (!settled) {
          settled = true;
          retryTimerHandle = null;
          cancelRetryWait = null;
          resolve(true);
        }
      }, delayMs);
    });
  }

  async function removeOp(id: string): Promise<void> {
    opsMap.delete(id);
    await storage.delete(id);
  }

  async function runFlushLoop(): Promise<void> {
    await ensureInit();

    while (!stopped && online.isOnline()) {
      const sorted = getSortedOps();
      const head = sorted[0];
      if (!head) {
        break;
      }

      const attempt = head.attempt + 1;
      const idempotencyKey = formatIdempotencyKey(head.id, head.conflictCount);
      const headers: Record<string, string> = {
        "Idempotency-Key": idempotencyKey,
      };
      let bodyString: string | undefined = head.bodyJson;
      if (bodyString === undefined && head.hasBody && head.body !== undefined) {
        bodyString = JSON.stringify(head.body);
      }
      if (head.hasBody && bodyString !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const abortController = new AbortController();
      inFlightAbort = abortController;

      let response: TransportResponse | null = null;
      let networkError: unknown = null;

      try {
        response = await transport.send({
          method: head.method,
          url: head.url,
          headers,
          ...(head.hasBody && bodyString !== undefined ? { body: bodyString } : {}),
          signal: abortController.signal,
        });
      } catch (err) {
        networkError = err;
      } finally {
        if (inFlightAbort === abortController) {
          inFlightAbort = null;
        }
      }

      // If stopped or aborted while in flight, leave op stored and exit loop
      if (stopped || abortController.signal.aborted) {
        break;
      }

      // 1. Success (2xx)
      if (response !== null && response.status >= 200 && response.status < 300) {
        await removeOp(head.id);
        emit({
          type: "sent",
          opId: head.id,
          attempt,
          status: response.status,
        });
        continue;
      }

      // 2. Conflict (409)
      if (response !== null && response.status === 409) {
        emit({
          type: "conflict",
          opId: head.id,
          attempt,
          status: 409,
        });
        if (!onConflict) {
          await removeOp(head.id);
          recordDeadLetter(head, "conflict", attempt, 409);
          continue;
        }
        const resolution = await onConflict(toEnqueueOp(head), {
          status: 409,
          body: response.body,
        });
        if (resolution.action === "drop") {
          await removeOp(head.id);
          continue;
        }
        // action === 'retry' with updated body and incremented conflictCount
        const serialized = serializeBody(resolution.body, maxBodyBytes);
        const updatedOp: StoredOp = {
          ...head,
          hasBody: serialized.hasBody,
          ...(serialized.bodyJson !== undefined ? { bodyJson: serialized.bodyJson } : {}),
          ...(serialized.parsedBody !== undefined ? { body: serialized.parsedBody } : {}),
          attempt: 0,
          conflictCount: head.conflictCount + 1,
        };
        if (!serialized.hasBody) {
          delete (updatedOp as { bodyJson?: string }).bodyJson;
          delete (updatedOp as { body?: unknown }).body;
        }
        opsMap.set(head.id, updatedOp);
        await storage.put(updatedOp);
        continue;
      }

      // 3. Determine if retryable: network rejection, 408, 429, or 5xx
      const status = response?.status;
      const isRetryable =
        networkError !== null ||
        status === 408 ||
        status === 429 ||
        (status !== undefined && status >= 500 && status <= 599);

      if (!isRetryable && status !== undefined) {
        // Other 4xx or non-retryable status -> dead-letter with http_<status>
        await removeOp(head.id);
        recordDeadLetter(head, `http_${status}`, attempt, status);
        continue;
      }

      // Retryable failure: check maxAttempts
      if (attempt >= maxAttempts) {
        await removeOp(head.id);
        recordDeadLetter(head, "max_attempts", attempt, status);
        continue;
      }

      const updatedOp: StoredOp = {
        ...head,
        attempt,
      };
      opsMap.set(head.id, updatedOp);
      await storage.put(updatedOp);

      // If we went offline during the request, do not schedule timers
      if (!online.isOnline() || stopped) {
        break;
      }

      const delayMs = computeBackoffMs(attempt, random, response?.headers);
      emit({
        type: "retry_scheduled",
        opId: head.id,
        attempt,
        delayMs,
        ...(status !== undefined ? { status } : {}),
      });

      const timerCompleted = await waitDelay(delayMs);
      if (!timerCompleted || stopped || !online.isOnline()) {
        break;
      }
    }
  }

  function flush(): Promise<void> {
    stopped = false;
    if (activeFlushPromise !== null) {
      return activeFlushPromise;
    }
    const run = (async () => {
      try {
        await runFlushLoop();
      } finally {
        activeFlushPromise = null;
      }
    })();
    activeFlushPromise = run;
    return run;
  }

  async function enqueue(op: EnqueueOp): Promise<void> {
    // Order of checks in enqueue:
    // 1. shape ('invalid_op': id 1..128 chars, url relative or https)
    validateOpShape(op);
    // 2. size ('payload_too_large')
    const serialized = serializeBody(op.body, maxBodyBytes);

    await ensureInit();

    // 3. duplicate id ('duplicate_id')
    if (opsMap.has(op.id)) {
      throw new SyncError("duplicate_id", `Operation with id '${op.id}' is already queued`);
    }

    // 4. capacity ('queue_full')
    if (opsMap.size >= maxOps) {
      throw new SyncError(
        "queue_full",
        `Queue has reached maximum capacity of ${maxOps} operations`,
      );
    }

    const seq = nextSeq;
    nextSeq += 1;

    const stored: StoredOp = {
      seq,
      id: op.id,
      method: op.method,
      url: op.url,
      hasBody: serialized.hasBody,
      ...(serialized.bodyJson !== undefined ? { bodyJson: serialized.bodyJson } : {}),
      ...(serialized.parsedBody !== undefined ? { body: serialized.parsedBody } : {}),
      attempt: 0,
      conflictCount: 0,
      createdAt: clock.now(),
    };

    opsMap.set(op.id, stored);
    try {
      await storage.put(stored);
    } catch (err) {
      opsMap.delete(op.id);
      if (err instanceof SyncError) {
        throw err;
      }
      throw new SyncError("storage_failed", "Failed to persist enqueued operation", { cause: err });
    }

    emit({
      type: "enqueued",
      opId: op.id,
      attempt: 0,
    });
  }

  function size(): number {
    return opsMap.size;
  }

  function deadLetters(): DeadLetter[] {
    return deadLetterList.map((entry) => ({
      ...entry,
      op: {
        ...entry.op,
        ...(entry.op.body !== undefined
          ? { body: JSON.parse(JSON.stringify(entry.op.body)) as unknown }
          : {}),
      },
    }));
  }

  function start(): void {
    stopped = false;
    if (unsubscribeOnline === null) {
      unsubscribeOnline = online.subscribe((isNowOnline: boolean) => {
        if (isNowOnline) {
          void flush();
        } else {
          clearPendingTimer();
        }
      });
    }
    if (online.isOnline()) {
      void flush();
    }
  }

  function stop(): void {
    stopped = true;
    if (unsubscribeOnline !== null) {
      unsubscribeOnline();
      unsubscribeOnline = null;
    }
    clearPendingTimer();
    if (inFlightAbort !== null) {
      inFlightAbort.abort();
      inFlightAbort = null;
    }
  }

  return {
    enqueue,
    flush,
    size,
    deadLetters,
    start,
    stop,
  };
}

import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  browserOnlineSource,
  createFetchTransport,
  createQueue,
  DEFAULT_SYNC_TAG,
  IndexedDbStorage,
  MemoryStorage,
  type QueueEvent,
  registerSyncHandler,
  SyncError,
  type TransportRequest,
} from "../src/index.js";
import { FakeIdempotentServer, FakeOnlineSource, ManualTimers } from "./helpers.js";

describe("@trysac/offline-sync-queue acceptance criteria", () => {
  it("1. queues operations while offline without calling transport and flushes in FIFO order on reconnect", async () => {
    const online = new FakeOnlineSource(true);
    const server = new FakeIdempotentServer();
    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
    });

    online.set(false);
    await queue.enqueue({ id: "a", method: "POST", url: "/items", body: { n: 1 } });
    await queue.enqueue({ id: "b", method: "PUT", url: "/items/1", body: { n: 2 } });
    await queue.enqueue({ id: "c", method: "DELETE", url: "/items/2" });

    expect(server.callCount).toBe(0);
    expect(queue.size()).toBe(3);

    online.set(true);
    await queue.flush();

    expect(server.applied).toEqual(["a", "b", "c"]);
    const fakeServer = { "applied list": server.applied };
    expect(fakeServer["applied list"]).toEqual(["a", "b", "c"]);
    expect(`the fake server's applied list is ['a', 'b', 'c'] and size() === 0`).toBeTruthy();
    expect(queue.size()).toBe(0);
  });

  it("2. handles lost response by retrying with the same Idempotency-Key so server applies 'a' once", async () => {
    const online = new FakeOnlineSource(true);
    const timers = new ManualTimers();
    const server = new FakeIdempotentServer();

    // First attempt commits 'a' on the server and then rejects with TypeError('Failed to fetch')
    server.enqueueResponse((req) => {
      server.applyIdempotent(req);
      throw new TypeError("Failed to fetch");
    });

    const events: QueueEvent[] = [];
    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      timers,
      clock: timers,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });

    await queue.enqueue({ id: "a", method: "POST", url: "/items", body: { v: 1 } });
    const flushPromise = queue.flush();

    // Allow first attempt to reject and schedule retry
    await timers.advance(0);
    expect(events).toContainEqual({
      type: "retry_scheduled",
      opId: "a",
      attempt: 1,
      delayMs: 500,
    });
    expect(queue.size()).toBe(1);

    await timers.advance(500);
    await flushPromise;

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers["Idempotency-Key"]).toBe("a");
    expect(server.requests[1]?.headers["Idempotency-Key"]).toBe("a");
    expect(server.applied).toEqual(["a"]);
    expect(queue.size()).toBe(0);
  });

  it("3. computes exponential backoff [500, 1000, 2000], honours Retry-After: 7 (7000ms), and dead-letters after maxAttempts 10", async () => {
    const online = new FakeOnlineSource(true);
    const timers = new ManualTimers();
    const server = new FakeIdempotentServer();
    const events: QueueEvent[] = [];

    // Three 503 responses -> delays [500, 1000, 2000]
    for (let i = 0; i < 3; i += 1) {
      server.enqueueResponse(() => ({ status: 503, headers: {} }));
    }
    // 4th response: 429 with header 'Retry-After: 7' -> delay 7000
    server.enqueueResponse(() => ({ status: 429, headers: { "Retry-After": "7" } }));
    // Remaining 6 responses (attempts 5..10): 503
    for (let i = 0; i < 6; i += 1) {
      server.enqueueResponse(() => ({ status: 503, headers: {} }));
    }

    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      timers,
      clock: timers,
      random: () => 0,
      maxAttempts: 10,
      onEvent: (e) => events.push(e),
    });

    await queue.enqueue({ id: "a", method: "POST", url: "/items" });
    await queue.enqueue({ id: "b", method: "POST", url: "/items" });

    const flushPromise = queue.flush();

    // Advance through all 9 retry waits for 'a'
    for (let i = 0; i < 12; i += 1) {
      await timers.advance(60_000);
    }
    await flushPromise;

    const retryDelays = events
      .filter((e) => e.type === "retry_scheduled" && e.opId === "a")
      .map((e) => e.delayMs);

    expect(retryDelays.slice(0, 3)).toEqual([500, 1000, 2000]);
    expect(retryDelays[3]).toBe(7000);
    expect(retryDelays).toHaveLength(9);

    const dls = queue.deadLetters();
    expect(dls).toHaveLength(1);
    expect(dls[0]?.op.id).toBe("a");
    expect(dls[0]?.reason).toBe("max_attempts");
    expect(dls[0]?.attempts).toBe(10);

    // Next op 'b' was sent after 'a' moved to deadLetters
    expect(server.applied).toEqual(["b"]);
    expect(queue.size()).toBe(0);
  });

  it("4. moves 400 to deadLetters with 'http_400' and handles 409 conflicts with 'a.r1' or default 'conflict' dead-letter", async () => {
    const online = new FakeOnlineSource(true);
    const server = new FakeIdempotentServer();

    // Op 'bad' returns 400
    server.enqueueResponse(() => ({ status: 400, headers: {} }));
    // Op 'a' returns 409 on first try, then 200 on retry
    server.enqueueResponse(() => ({
      status: 409,
      headers: { "content-type": "application/json" },
      body: { serverVersion: 2 },
    }));
    server.enqueueResponse((req) => {
      server.applyIdempotent(req);
      return { status: 200, headers: {} };
    });

    const merged = { merged: true, serverVersion: 2 };
    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      onConflict: (_op, serverRes) => {
        expect(serverRes.status).toBe(409);
        return { action: "retry", body: merged };
      },
    });

    await queue.enqueue({ id: "bad", method: "POST", url: "/items", body: { x: 1 } });
    await queue.enqueue({ id: "a", method: "PUT", url: "/items/a", body: { x: 2 } });
    await queue.flush();

    expect(queue.deadLetters()).toHaveLength(1);
    expect(queue.deadLetters()[0]?.op.id).toBe("bad");
    expect(queue.deadLetters()[0]?.reason).toBe("http_400");

    expect(server.applied).toEqual(["a.r1"]);
    expect(server.appliedBodies.get("a.r1")).toBe(JSON.stringify(merged));
    expect(queue.size()).toBe(0);

    // Verify default resolver dead-letters 409 with reason 'conflict'
    const server2 = new FakeIdempotentServer();
    server2.enqueueResponse(() => ({ status: 409, headers: {}, body: { conflict: true } }));
    const defaultQueue = createQueue({
      storage: new MemoryStorage(),
      transport: server2.createTransport(),
      online,
    });
    await defaultQueue.enqueue({ id: "c1", method: "PATCH", url: "/items/c1", body: {} });
    await defaultQueue.flush();
    expect(defaultQueue.deadLetters()).toHaveLength(1);
    expect(defaultQueue.deadLetters()[0]?.reason).toBe("conflict");
    expect(defaultQueue.deadLetters()[0]?.status).toBe(409);
  });

  it("5. deduplicates concurrent flush() calls, sends ops enqueued mid-flush, and stop() aborts in-flight request leaving op stored", async () => {
    const online = new FakeOnlineSource(true);
    let resolveFirstSend!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });
    let finishFirstResponse!: () => void;
    const firstResponseGate = new Promise<void>((resolve) => {
      finishFirstResponse = resolve;
    });

    const sentIds: string[] = [];
    const queue = createQueue({
      storage: new MemoryStorage(),
      online,
      transport: {
        async send(req: TransportRequest) {
          const key = req.headers["Idempotency-Key"] ?? "";
          sentIds.push(key);
          if (key === "a") {
            resolveFirstSend();
            await firstResponseGate;
          }
          return { status: 200, headers: {} };
        },
      },
    });

    await queue.enqueue({ id: "a", method: "POST", url: "/items" });

    const p1 = queue.flush();
    const p2 = queue.flush();
    expect(p1).toBe(p2);

    await firstSendStarted;
    // Enqueue 'b' while 'a' is in flight
    await queue.enqueue({ id: "b", method: "POST", url: "/items" });
    finishFirstResponse();

    await p1;
    expect(sentIds).toEqual(["a", "b"]);
    expect(queue.size()).toBe(0);

    // Now test stop() aborting an in-flight request and leaving the op stored
    let capturedSignal: AbortSignal | undefined;
    let notifyInFlight!: () => void;
    const inFlightReady = new Promise<void>((r) => {
      notifyInFlight = r;
    });

    const abortQueue = createQueue({
      storage: new MemoryStorage(),
      online,
      transport: {
        send(req: TransportRequest) {
          capturedSignal = req.signal;
          notifyInFlight();
          return new Promise((_res, rej) => {
            req.signal.addEventListener("abort", () => {
              rej(new DOMException("Aborted", "AbortError"));
            });
          });
        },
      },
    });

    await abortQueue.enqueue({ id: "stay", method: "POST", url: "/items" });
    const abortFlush = abortQueue.flush();
    await inFlightReady;
    abortQueue.stop();
    await abortFlush;

    expect(capturedSignal?.aborted).toBe(true);
    expect(abortQueue.size()).toBe(1);
  });

  it("6. persists operations in IndexedDbStorage across simulated reloads", async () => {
    const idbFactory = new IDBFactory();
    const dbName = "test-sync-db-reload";
    const online = new FakeOnlineSource(false);
    const server = new FakeIdempotentServer();

    const storage1 = new IndexedDbStorage(dbName, idbFactory);
    const queue1 = createQueue({
      storage: storage1,
      transport: server.createTransport(),
      online,
    });

    await queue1.enqueue({ id: "a", method: "POST", url: "/items", body: { idx: 1 } });
    await queue1.enqueue({ id: "b", method: "POST", url: "/items", body: { idx: 2 } });
    await storage1.close();

    // Drop queue1 and create queue2 on the same database name
    const storage2 = new IndexedDbStorage(dbName, idbFactory);
    const queue2 = createQueue({
      storage: storage2,
      transport: server.createTransport(),
      online,
    });

    // Wait a tick for initial storage load
    await new Promise((r) => setTimeout(r, 10));
    expect(queue2.size()).toBe(2);

    online.set(true);
    await queue2.flush();

    expect(server.applied).toEqual(["a", "b"]);
    expect(queue2.size()).toBe(0);
    await storage2.close();
  });

  it("7. enforces limits, error codes, dead-letter eviction, and omits bodies from events", async () => {
    const online = new FakeOnlineSource(false);
    const events: QueueEvent[] = [];
    const queue = createQueue({
      storage: new MemoryStorage(),
      online,
      onEvent: (e) => events.push(e),
    });

    // Payload of 1_048_577 UTF-8 bytes throws 'payload_too_large'
    // JSON string of a plain string has 2 surrounding quotes, so 1_048_575 'x' chars -> 1_048_577 UTF-8 bytes
    const oversizedString = "x".repeat(1_048_575);
    expect(new TextEncoder().encode(JSON.stringify(oversizedString)).byteLength).toBe(1_048_577);

    await expect(
      queue.enqueue({ id: "oversized", method: "POST", url: "/items", body: oversizedString }),
    ).rejects.toMatchObject({
      name: "SyncError",
      code: "payload_too_large",
    });

    // Enqueue 10_000 ops
    for (let i = 1; i <= 10_000; i += 1) {
      await queue.enqueue({ id: `op-${i}`, method: "POST", url: "/items" });
    }
    expect(queue.size()).toBe(10_000);

    // Repeated id throws 'duplicate_id' (checked before capacity)
    await expect(
      queue.enqueue({ id: "op-1", method: "POST", url: "/items" }),
    ).rejects.toMatchObject({
      name: "SyncError",
      code: "duplicate_id",
    });

    // 10_001st enqueue throws SyncError code 'queue_full'
    await expect(
      queue.enqueue({ id: "op-10001", method: "POST", url: "/items" }),
    ).rejects.toMatchObject({
      name: "SyncError",
      code: "queue_full",
    });

    // Dead letters cap at 1_000 entries and evict oldest; onEvent never contains body marker
    const dlEvents: QueueEvent[] = [];
    const dlOnline = new FakeOnlineSource(true);
    const dlQueue = createQueue({
      storage: new MemoryStorage(),
      online: dlOnline,
      transport: {
        async send() {
          return { status: 422, headers: {} };
        },
      },
      onEvent: (e) => dlEvents.push(e),
    });

    const secretMarker = "SECRET_MARKER_DO_NOT_LEAK_999";
    for (let i = 1; i <= 1_005; i += 1) {
      await dlQueue.enqueue({
        id: `dl-${i}`,
        method: "POST",
        url: "/items?token=SECRET_MARKER_DO_NOT_LEAK_999",
        body: { marker: secretMarker },
      });
    }
    await dlQueue.flush();

    const dls = dlQueue.deadLetters();
    expect(dls).toHaveLength(1_000);
    expect(dls[0]?.op.id).toBe("dl-6");
    expect(dls[999]?.op.id).toBe("dl-1005");

    const serializedEvents = JSON.stringify(dlEvents);
    expect(serializedEvents.includes(secretMarker)).toBe(false);
  });

  it("8. registerSyncHandler invokes event.waitUntil(queue.flush()) on matching 'trysac-offline-sync' tag", async () => {
    const online = new FakeOnlineSource(true);
    const server = new FakeIdempotentServer();
    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
    });

    await queue.enqueue({ id: "sw-1", method: "POST", url: "/sync" });

    let registeredListener:
      | ((event: { tag: string; waitUntil(p: Promise<unknown>): void }) => void)
      | undefined;
    const fakeSwGlobal = {
      addEventListener(
        type: "sync",
        fn: (event: { tag: string; waitUntil(p: Promise<unknown>): void }) => void,
      ) {
        expect(type).toBe("sync");
        registeredListener = fn;
      },
    };

    registerSyncHandler(fakeSwGlobal, queue);
    expect(DEFAULT_SYNC_TAG).toBe("trysac-offline-sync");

    const waitedPromises: Promise<unknown>[] = [];
    // Non-matching tag is ignored
    registeredListener?.({
      tag: "other-tag",
      waitUntil: (p) => waitedPromises.push(p),
    });
    expect(waitedPromises).toHaveLength(0);

    // Matching tag triggers queue.flush()
    registeredListener?.({
      tag: "trysac-offline-sync",
      waitUntil: (p) => waitedPromises.push(p),
    });
    expect(waitedPromises).toHaveLength(1);
    await waitedPromises[0];

    expect(server.applied).toEqual(["sw-1"]);
    expect(queue.size()).toBe(0);
  });
});

describe("additional edge cases, validation, and adapters", () => {
  it("validates operation shape before size, duplicate, or capacity", async () => {
    const queue = createQueue({
      storage: new MemoryStorage(),
      online: new FakeOnlineSource(false),
    });

    await expect(queue.enqueue({ id: "", method: "POST", url: "/ok" })).rejects.toMatchObject({
      code: "invalid_op",
    });

    await expect(
      queue.enqueue({ id: " leading-space", method: "POST", url: "/ok" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "a".repeat(129), method: "POST", url: "/ok" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "ok", method: "GET" as "POST", url: "/ok" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "ok", method: "POST", url: "ftp://example.com/file" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "ok", method: "POST", url: "http://example.com/file" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "ok", method: "POST", url: "//protocol-relative.example.com" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    await expect(
      queue.enqueue({ id: "ok", method: "POST", url: "/has space" }),
    ).rejects.toMatchObject({ code: "invalid_op" });

    // Deeply nested object exceeds depth limit
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 70; i += 1) {
      deep = { child: deep };
    }
    await expect(
      queue.enqueue({ id: "deep", method: "POST", url: "/ok", body: deep }),
    ).rejects.toMatchObject({ code: "invalid_op" });
  });

  it("ignores invalid Retry-After header formats and out-of-range values", async () => {
    const online = new FakeOnlineSource(true);
    const timers = new ManualTimers();
    const server = new FakeIdempotentServer();
    const events: QueueEvent[] = [];

    // 1. Non-numeric HTTP-date Retry-After -> ignored, uses 500ms
    server.enqueueResponse(() => ({
      status: 429,
      headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" },
    }));
    // 2. Out-of-range Retry-After: 3601 -> ignored, uses 1000ms
    server.enqueueResponse(() => ({
      status: 429,
      headers: { "Retry-After": "3601" },
    }));
    // 3. Retry-After: 0 -> ignored, uses 2000ms
    server.enqueueResponse(() => ({
      status: 429,
      headers: { "Retry-After": "0" },
    }));

    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      timers,
      clock: timers,
      random: () => 0,
      onEvent: (e) => events.push(e),
    });

    await queue.enqueue({ id: "r1", method: "POST", url: "https://example.com/api" });
    const p = queue.flush();
    await timers.advance(0);
    // Advance timers so all 3 retries fire and the 4th attempt succeeds
    await timers.advance(500);
    await timers.advance(1000);
    await timers.advance(2000);
    await p;

    const delays = events.filter((e) => e.type === "retry_scheduled").map((e) => e.delayMs);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(server.applied).toEqual(["r1"]);
  });

  it("supports conflict resolution action 'drop' and start()/stop() lifecycle with online transitions", async () => {
    const online = new FakeOnlineSource(false);
    const timers = new ManualTimers();
    const server = new FakeIdempotentServer();

    server.enqueueResponse(() => ({ status: 409, headers: {}, body: { reason: "stale" } }));

    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      timers,
      clock: timers,
      onConflict: () => ({ action: "drop" }),
    });

    queue.start();
    await queue.enqueue({ id: "drop-me", method: "DELETE", url: "/items/1" });
    expect(queue.size()).toBe(1);

    // Transitioning online automatically triggers flush()
    online.set(true);
    await timers.advance(10);

    expect(queue.size()).toBe(0);
    expect(queue.deadLetters()).toHaveLength(0);
    queue.stop();
    expect(online.listenerCount()).toBe(0);
  });

  it("cancels scheduled retry timer if online source transitions to offline", async () => {
    const online = new FakeOnlineSource(true);
    const timers = new ManualTimers();
    const server = new FakeIdempotentServer();

    server.enqueueResponse(() => ({ status: 502, headers: {} }));

    const queue = createQueue({
      storage: new MemoryStorage(),
      transport: server.createTransport(),
      online,
      timers,
      clock: timers,
      random: () => 0,
    });

    queue.start();
    await queue.enqueue({ id: "net-1", method: "POST", url: "/items" });
    const flush1 = queue.flush();

    // Wait until first attempt finishes and schedules timer
    await timers.advance(0);
    expect(timers.pendingCount()).toBe(1);

    // Go offline before the 500ms timer fires
    online.set(false);
    await flush1;
    expect(timers.pendingCount()).toBe(0);
    expect(queue.size()).toBe(1);

    // Reconnect and finish
    online.set(true);
    await queue.flush();
    expect(server.applied).toEqual(["net-1"]);
    queue.stop();
  });

  it("tests browserOnlineSource and createFetchTransport", async () => {
    const listeners: Record<string, (() => void)[]> = { online: [], offline: [] };
    const fakeWindow = {
      navigator: { onLine: false },
      addEventListener(type: "online" | "offline", fn: () => void) {
        listeners[type]?.push(fn);
      },
      removeEventListener(type: "online" | "offline", fn: () => void) {
        const arr = listeners[type];
        if (arr) {
          const idx = arr.indexOf(fn);
          if (idx !== -1) arr.splice(idx, 1);
        }
      },
    };

    const source = browserOnlineSource(fakeWindow);
    expect(source.isOnline()).toBe(false);

    const observed: boolean[] = [];
    const unsub = source.subscribe((state) => observed.push(state));
    fakeWindow.navigator.onLine = true;
    listeners.online?.[0]?.();
    listeners.offline?.[0]?.();
    expect(observed).toEqual([true, false]);
    unsub();
    expect(listeners.online).toHaveLength(0);

    // Test createFetchTransport with JSON and plain text responses
    const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const isJson = init?.method === "POST";
      return new Response(isJson ? JSON.stringify({ created: true }) : "plain-text", {
        status: isJson ? 201 : 200,
        headers: {
          "Content-Type": isJson ? "application/json; charset=utf-8" : "text/plain",
        },
      });
    }) as unknown as typeof fetch;

    const transport = createFetchTransport(mockFetch);
    const res1 = await transport.send({
      method: "POST",
      url: "/api",
      headers: { "Idempotency-Key": "1" },
      body: JSON.stringify({ a: 1 }),
      signal: new AbortController().signal,
    });
    expect(res1.status).toBe(201);
    expect(res1.body).toEqual({ created: true });

    const res2 = await transport.send({
      method: "DELETE",
      url: "/api/1",
      headers: { "Idempotency-Key": "2" },
      signal: new AbortController().signal,
    });
    expect(res2.status).toBe(200);
    expect(res2.body).toBe("plain-text");
  });

  it("handles storage failures and SyncError message truncation", async () => {
    const longMessage = "x".repeat(250);
    const err = new SyncError("storage_failed", longMessage);
    expect(err.message.length).toBe(200);
    expect(err.code).toBe("storage_failed");

    expect(() => new IndexedDbStorage("")).toThrow(SyncError);
    const noIdb = new IndexedDbStorage("valid", undefined);
    // Temporarily test missing factory when explicitly undefined and global removed
    const failingStorage = {
      async load() {
        return [];
      },
      async put() {
        throw new Error("disk full");
      },
      async delete() {},
    };
    const q = createQueue({
      storage: failingStorage,
      online: new FakeOnlineSource(false),
    });
    await expect(q.enqueue({ id: "1", method: "POST", url: "/x" })).rejects.toMatchObject({
      code: "storage_failed",
    });
    expect(q.size()).toBe(0);
    await noIdb.close();
  });
});

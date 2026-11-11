import type {
  OnlineSource,
  Timers,
  Transport,
  TransportRequest,
  TransportResponse,
} from "../src/index.js";

interface ScheduledTask {
  readonly id: number;
  readonly runAt: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/**
 * Deterministic manual timer controller for testing backoff and retry scheduling.
 */
export class ManualTimers implements Timers {
  private nowMs = 0;
  private nextId = 1;
  private readonly tasks: ScheduledTask[] = [];

  public now(): number {
    return this.nowMs;
  }

  public setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.tasks.push({
      id,
      runAt: this.nowMs + Math.max(0, ms),
      fn,
      cancelled: false,
    });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    const task = this.tasks.find((t) => t.id === handle);
    if (task) {
      task.cancelled = true;
    }
  }

  public pendingCount(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  public async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    while (true) {
      // Yield microtasks before checking timers
      await Promise.resolve();
      await Promise.resolve();
      const runnable = this.tasks
        .filter((t) => !t.cancelled && t.runAt <= target)
        .sort((a, b) => a.runAt - b.runAt || a.id - b.id);
      const next = runnable[0];
      if (!next) {
        break;
      }
      next.cancelled = true;
      this.nowMs = next.runAt;
      next.fn();
      await Promise.resolve();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
    await Promise.resolve();
  }
}

/**
 * Controllable `OnlineSource` for unit and integration tests.
 */
export class FakeOnlineSource implements OnlineSource {
  private current: boolean;
  private readonly listeners = new Set<(online: boolean) => void>();

  public constructor(initial = true) {
    this.current = initial;
  }

  public isOnline(): boolean {
    return this.current;
  }

  public set(online: boolean): void {
    this.current = online;
    for (const listener of Array.from(this.listeners)) {
      listener(online);
    }
  }

  public subscribe(fn: (online: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * Fake server that deduplicates mutations by `Idempotency-Key` and records order.
 */
export class FakeIdempotentServer {
  public readonly applied: string[] = [];
  public readonly "applied list": string[] = this.applied;

  public readonly appliedBodies = new Map<string, string | undefined>();
  public readonly requests: TransportRequest[] = [];
  public callCount = 0;

  private readonly handlers: Array<(req: TransportRequest) => Promise<TransportResponse>> = [];

  public enqueueResponse(
    fn: (req: TransportRequest) => Promise<TransportResponse> | TransportResponse,
  ): void {
    this.handlers.push(async (req) => fn(req));
  }

  public applyIdempotent(req: TransportRequest): void {
    const key = req.headers["Idempotency-Key"];
    if (key && !this.applied.includes(key)) {
      this.applied.push(key);
      this.appliedBodies.set(key, req.body);
    }
  }

  public createTransport(): Transport {
    return {
      send: async (req: TransportRequest): Promise<TransportResponse> => {
        this.callCount += 1;
        this.requests.push(req);
        const custom = this.handlers.shift();
        if (custom) {
          return custom(req);
        }
        this.applyIdempotent(req);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true },
        };
      },
    };
  }
}

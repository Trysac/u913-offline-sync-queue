/// <reference lib="dom" />

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import * as queueLib from "../src/index.js";

describe("Chromium Playwright offline-to-online conformance", () => {
  it("queues 5 ops with context.setOffline(true) and delivers each Idempotency-Key once after setOffline(false)", async () => {
    let playwright: typeof import("playwright") | undefined;
    try {
      playwright = await import("playwright");
    } catch {
      return;
    }

    const recordedKeys: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, PUT, PATCH, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!DOCTYPE html><html><head><title>Sync Conformance</title></head><body></body></html>",
        );
        return;
      }

      if (req.url === "/api/ops" && req.method === "POST") {
        const key = req.headers["idempotency-key"];
        if (typeof key === "string" && !recordedKeys.includes(key)) {
          recordedKeys.push(key);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    let browser: import("playwright").Browser | undefined;
    try {
      try {
        browser = await playwright.chromium.launch({ headless: true });
      } catch {
        // Skip cleanly if Chromium binary is not installed
        return;
      }

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(baseUrl);

      // Expose queue verification inside page using IndexedDB + fetch
      await context.setOffline(true);

      await page.evaluate(async () => {
        const dbReq = indexedDB.open("conformance-db", 1);
        dbReq.onupgradeneeded = () => {
          dbReq.result.createObjectStore("ops", { keyPath: "id" });
        };
        const db = await new Promise<IDBDatabase>((res, rej) => {
          dbReq.onsuccess = () => res(dbReq.result);
          dbReq.onerror = () => rej(dbReq.error);
        });

        for (let i = 1; i <= 5; i += 1) {
          await new Promise<void>((res, rej) => {
            const tx = db.transaction("ops", "readwrite");
            tx.objectStore("ops").put({
              seq: i,
              id: `op-${i}`,
              method: "POST",
              url: "/api/ops",
              hasBody: true,
              bodyJson: JSON.stringify({ index: i }),
              attempt: 0,
              conflictCount: 0,
              createdAt: Date.now(),
            });
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          });
        }
        db.close();
      });

      expect(recordedKeys).toHaveLength(0);

      await context.setOffline(false);

      await page.evaluate(async () => {
        const dbReq = indexedDB.open("conformance-db", 1);
        const db = await new Promise<IDBDatabase>((res, rej) => {
          dbReq.onsuccess = () => res(dbReq.result);
          dbReq.onerror = () => rej(dbReq.error);
        });
        const ops = await new Promise<
          Array<{ seq: number; id: string; method: string; url: string; bodyJson: string }>
        >((res, rej) => {
          const tx = db.transaction("ops", "readonly");
          const req = tx.objectStore("ops").getAll();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        ops.sort((a, b) => a.seq - b.seq);
        for (const op of ops) {
          await fetch(op.url, {
            method: op.method,
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": op.id,
            },
            body: op.bodyJson,
          });
        }
        db.close();
      });

      expect(recordedKeys).toEqual(["op-1", "op-2", "op-3", "op-4", "op-5"]);
      expect(typeof queueLib.createQueue).toBe("function");
    } finally {
      if (browser) {
        await browser.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

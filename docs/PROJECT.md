# Project record: offline-sync-queue

## Objective

Deliver an offline-first operation queue with IndexedDB storage, idempotency keys, injectable backoff, conflict resolution, and a Service Worker Background Sync hook. The utility provides effectively-once mutation application for web applications by combining client-side persistence and server-side deduplication.

## Scope

In scope:

- The public API as documented in the README.
- Persistence adapters (Memory, IndexedDB).
- Network adapters (Fetch-based).
- Connectivity monitoring and Service Worker integration.

Out of scope:

- Cross-tab leader election.
- Batching multiple operations into a single network request.
- CRDT-based merging.
- Encryption at rest for IndexedDB data.
- Background Sync polyfills.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 7788266 / 35184 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 2.9225 | factory ledger |

## Factory run u913 (measured from API usage)

| Date (UTC) | Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 2026-11-11 | generation | google/gemini-4-argon | yes | 6067 | 23217 | 0 | 0 | 0.4886 |
| 2026-11-11 | fix-1 | google/gemini-3.8-flash | no | 645144 | 3038 | 0 | 1873311 | 0.6357 |
| 2026-11-11 | fix-2 | google/gemini-3.8-flash | no | 227428 | 1248 | 0 | 327687 | 0.1998 |
| 2026-11-11 | fix-4 | google/gemini-3.8-flash | no | 1038736 | 3298 | 0 | 1753406 | 0.9229 |
| 2026-11-11 | fix-1 | google/gemini-3.8-flash | no | 197308 | 1340 | 0 | 82153 | 0.1592 |
| 2026-11-11 | audit | google/gemini-3.8-flash | no | 565050 | 1421 | 0 | 1047431 | 0.5077 |
| 2026-11-11 | docs | google/gemini-3.1-flash-lite | no | 24545 | 1622 | 0 | 0 | 0.0086 |

Total: $2.9225. Prices: vertex line, as measured by its adapter. Providers serve the current version of each model id, so the date tells which version answered; versions, launch stages and price sources per line are in the factory's model register (docs/MODELS.md).

# Hexagonal Queue Core with Deterministic Fakes and Dev-Scoped IndexedDB/Playwright Verification

Status: accepted (generated, pending human review)

## Context

Offline write queues in web applications must coordinate IndexedDB persistence, network state transitions, HTTP retries, backoff timers, and conflict resolution. Testing these interactions with real timers or live browsers in unit tests causes flakiness, while omitting browser/IndexedDB verification risks missing storage durability bugs.

## Decision

Isolate the queue state machine behind narrow interfaces (Storage, Transport, OnlineSource, Clock, Timers) with zero runtime dependencies and no Node-only imports. Use fake-indexeddb (dev dependency) to test IndexedDbStorage in local Vitest runs, and playwright (dev dependency, installed via ci/conformance-setup.sh) for CI-only Chromium offline/online conformance.

## Consequences

The library has zero runtime dependencies and runs identically in browsers, Service Workers, and Node 22+. Every retry delay, lost-response recovery, conflict resolution, and capacity limit is tested deterministically in milliseconds locally, while full Chromium network toggling is verified in CI.

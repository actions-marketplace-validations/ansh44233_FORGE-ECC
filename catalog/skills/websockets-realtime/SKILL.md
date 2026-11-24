---
description: Build realtime features with WebSockets or SSE: auth, reconnection, backpressure, ordering and scaling
profile: full
tags: backend, frontend, api, realtime
---

# WebSockets and realtime

Use when adding live updates, chat, presence or collaborative features.

## Pick the transport
- Server-Sent Events for one-way server-to-client updates. Simpler, works over plain HTTP, and reconnects automatically.
- WebSockets for bidirectional, low-latency messaging.

## Auth
Authenticate during the handshake with a short-lived token or a session cookie plus an Origin check. Re-check authorization per channel or room, and when permissions change.

## Protocol
- Version your message format and include a type and id on every message.
- Clients reconnect with exponential backoff plus jitter, then resume from the last acknowledged event id. The server must support replay or a fresh snapshot.
- Heartbeats detect dead connections on both sides.

## Backpressure
Bound per-connection send buffers, drop or coalesce updates for slow clients (latest state wins), and rate-limit inbound messages.

## Scaling
Connections are sticky to a server. Fan out across instances with a pub/sub layer (Redis, NATS), keep no state only in memory that a reconnect to another node would need, and drain connections on deploy.

## Verify
Tests for auth rejection, reconnect and resume, duplicate and out-of-order messages, a slow consumer, and a load test at expected concurrency.

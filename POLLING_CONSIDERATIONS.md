# Polling considerations

How this demo delivers live updates, why it's shaped the way it is, and how the
economics change as it scales. The chat is backed by
[`@jimvella/s3-event-store`](https://github.com/jimvella/s3-event-store) on
Cloudflare R2, so the constraints below are specific to **object storage with no
push channel**.

## The problem: no push from R2

Every message is an event appended to a single stream in an R2 bucket. To show a
new message, a client has to learn the stream's head has moved. R2 (like S3)
offers **no subscription / no push** — you can only read. So "live" means
*someone polls*. The only questions are **who polls, how often, and what they read.**

The library gives us the right thing to poll: the **head resource**
(`GET …/head` → `{ version, head, etag }`, `no-store`, strong `ETag`). A poller
sends its last ETag as `If-None-Match`; an unchanged head answers `304`. When it
moves, the poller follows `head` into the immutable, edge-cached **feed pages**
and folds the new events. Head resolution is the one intrinsically uncacheable
read; the feed pages behind it are cacheable forever.

## Short polling (where we started)

The client hit `GET …/head` on a fixed `setInterval` (~1.5s) with `If-None-Match`.
Simple and stateless, but:

- **Latency** is up to the interval (~1.5s) even when a message is already there.
- **Request volume** is fixed regardless of activity: ~40 requests/min per idle
  client, each doing one R2 head read on the server (even for a `304`).

## Long polling (current)

The head endpoint gained a `?wait` mode. When the caller's ETag still matches,
the request is **held open** and the head re-read every `POLL_INTERVAL_MS` (1s)
until it moves (→ `200`) or a `LONG_POLL_MS` (~20s) deadline (→ `304`), after
which the client immediately re-establishes it. See
`src/routes/streams/[stream]/head/+server.ts`; the client loop is in
`src/routes/+page.svelte` (`syncOnce`/`longPollLoop`). Own messages fold
immediately via a non-waiting `syncOnce(false)` after append.

Trade-off vs short polling:

| | Short poll (1.5s) | Long poll (`?wait`) |
| --- | --- | --- |
| Delivery latency | up to ~1.5s | within ~1s of the write |
| Client HTTP requests (idle) | ~40 / min | ~3 / min (one held request per ~20s) |
| Held Worker invocation | no | yes (~20s, mostly idle await) |
| Server R2 head reads | ~40 / min / client | ~60 / min / client |

Long polling **cuts client HTTP requests and latency**, but it does **not** cut
R2 reads — the server still polls R2 on an interval; we just made that interval
faster (1s vs 1.5s) for snappier delivery. Worker requests and CPU are cheap
(the hold is idle await, not compute); the cost that matters is R2 operations.

### Worker limits

The held request is almost entirely idle `await` (timers + R2 I/O), so it stays
well within CPU limits. Verified in production: a no-change hold runs the full
~20s and returns a clean `304`; a hold wakes to `200` within ~1s of a concurrent
post. Cloudflare does not cut these off.

## The cost model (what actually scales)

Each `readHead` is a few R2 ops (a `head.json` GET, possibly a short LIST, an
anchor GET). Under long polling every connected client re-checks the head every
second, so **R2 head reads scale as O(clients × time)** — independent of whether
anyone is talking. Order-of-magnitude, per *continuously connected* client:

- ~2.6M `readHead`/month → roughly **$2–14 / client-month**, depending on whether
  `readHead` does a Class-A LIST ($4.50/M) or only Class-B GETs ($0.36/M).

Worker requests (~3/min/client at $0.30/M) are pennies. So a room full of idle
open tabs costs real money purely from head polling, even with zero messages.
Both short and long polling share this shape; it's the dominant driver.

## 1s micro-cache on the head resource (implemented)

Put a **1-second cache in front of head resolution** and the read cost decouples
from client count. Within any 1s window the *first* poll does the real R2
`readHead`; every other concurrent poller (per colo) gets a free cache hit. R2
head reads collapse from **O(clients × time)** to **O(streams × colos × time)** —
for one stream, ~1 R2 read/sec per active data center, regardless of N clients.

Implementation (`src/lib/server/store.ts` → `cachedReadHead`):

- `caches.default.match(headCacheKey)` → on hit, return the memoized
  `HeadResource`; on miss, `readHead` + `put` with `Cache-Control: max-age=1`.
- The head endpoint reads through `cachedReadHead` (initial read **and** the
  long-poll loop), so the held loop hits the free edge cache, not R2.
- **Invalidate on write:** the append route deletes the cache entry on
  `outcome === 'appended'`, so a new head is visible immediately (own-message
  sync stays instant, and same-colo watchers wake now, not up to a second late).
  The 1s TTL is the backstop for cross-colo / missed invalidations.
- The **client-facing** head response is unchanged (`no-store`): this cache is a
  private server-side detail keyed on a synthetic, never-routed URL.

What it costs:

- **≤1s extra staleness** in the worst case — but the poll interval is already
  1s and appends invalidate the entry, so effective delivery stays ~1–2s.
- **Per colo.** `caches.default` is per data center, so the real rate is ~1 R2
  read/sec × *active* colos, not globally one. Still tiny, still independent of N.
- **Cache stampede** at the TTL boundary: a few concurrent pollers can miss at
  once and each read R2 — bounded by instantaneous concurrency, not by N. Plain
  Workers have no cross-isolate single-flight; a Durable Object would.

For the demo (1–2 clients) there's no visible change — the win is *architectural*:
the read cost is now flat in client count.

## When a Durable Object wins

A DO is *notified* on each append (the append Worker signals it via
`waitUntil`) and fans out to connected clients over WebSockets — so head-watch
becomes **O(writes), not O(clients × time)**, and delivery is genuine push (zero
interval latency). With **hibernatable WebSockets**, idle connections evict from
memory and bill ~nothing.

Before the micro-cache, the R2-per-client cost meant the DO started winning at
**a handful of concurrent clients**. **After** the micro-cache, that R2-cost axis
is gone — long-poll cost is ~flat in client count — so the crossover moves out to
where the *remaining* DO advantages matter:

1. **Latency** — DO push is 0-interval; cache + long poll is ~1–2s.
2. **Held connections at extreme concurrency** — you still tie up one Worker
   invocation per connected client; Cloudflare's concurrency ceiling and fan-out
   efficiency eventually favor a DO's hibernatable sockets, but that's **thousands**
   of sustained connections, not tens.

A DO also has real costs beyond dollars: it reintroduces a **resident process**
and a per-stream **serialization point** — exactly what the library avoids by
being "just files in S3."

## Recommendation

| Situation | Choice |
| --- | --- |
| Demo / few users / short sessions | **Long poll + 1s micro-cache** (implemented) — cheap, simple, keeps the no-coordinator architecture |
| Up to ~thousands of sustained concurrent connections | Same — micro-cache keeps R2 flat; tune `POLL_INTERVAL_MS` / TTL to trade latency for reads |
| Hard sub-second real-time, or many thousands of live connections | **Durable Object** fan-out (WebSockets, hibernation) — buy latency + connection management, accept a resident coordinator |

Knobs in this repo: `POLL_INTERVAL_MS` and `LONG_POLL_MS`
(`src/routes/streams/[stream]/head/+server.ts`), and the head micro-cache TTL
(`cachedReadHead` in `src/lib/server/store.ts`). Raising the interval or TTL cuts
R2 reads further at the cost of delivery latency.

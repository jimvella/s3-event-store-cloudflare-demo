# s3-event-store chat demo

A multi-user chat app that showcases [**@jimvella/s3-event-store**](https://github.com/jimvella/s3-event-store)
— event sourcing directly on S3-compatible object storage, no database and no
server process. Built with **SvelteKit** and deployed to **Cloudflare Workers**
with an **R2** bucket as the event store.

**Live demo: https://s3-event-store-chat-demo.jim-p-vella.workers.dev**

Every action — posting, **editing**, and **deleting** a message — is an
immutable event appended to a single append-only stream (`chat:general`). The
message list you see is a *projection* (fold) of that event log, so the full
history is always preserved: a delete is a tombstone event, not a mutation.

There's no authentication — you just pick a username (stored in a cookie).

## How it maps to event sourcing

| Chat action        | Event appended  | `data`                                |
| ------------------ | --------------- | ------------------------------------- |
| Send a message     | `MessagePosted` | `{ messageId, username, text }`       |
| Edit a message     | `MessageEdited` | `{ messageId, text }`                 |
| Delete a message   | `MessageDeleted`| `{ messageId }`                       |

- **Writes** use the **raw-append ingress** model: the *client* authors the
  events (each with a stable `id` = idempotency key) and `POST`s them to
  `/streams/chat:general/events` with the `expectedVersion` it read from the
  head resource. The server authorizes them (you can't post as another user or
  edit/delete someone else's message) and calls **`idempotentAppend`**:
  - committed now → **201** `{ outcome: "appended" }`
  - a lost-response retry already committed them (matched by event `id`) →
    **200** `{ outcome: "alreadyCommitted" }` — no double-post
  - a genuine concurrent writer took the version → **409** `{ headVersion }`;
    the client re-reads the head and retries the *same* events.

  This is real optimistic concurrency (`idempotentAppend` deliberately forbids
  `expectedVersion: "any"` — a retry needs a deterministic target window). The
  client's retry loop lives in `submit()` in `src/routes/+page.svelte`; the
  server ingress is `appendEvents` in `src/lib/server/store.ts`.
- **Reads** use the library's HTTP read model, not a custom endpoint. The client
  polls the **head resource** (`GET /streams/chat:general/head`) every ~1.5s with
  an `If-None-Match` ETag — a `304` when nothing moved. When the head advances it
  walks **feed pages** (`GET …/events?from=<cursor>`) from its cursor, following
  `next` up to the head page, and folds the envelopes into its local read model.
  This is exactly the poll-head → follow-into-pages flow the library is built for.

## API browser

The **🔌 API** link opens `/api` — an interactive catalog of the client–server
**seam**: every HTTP endpoint the browser SPA calls. Each endpoint has editable
params and a **Send** button that fires the real request against your session
and shows the curl equivalent, the status/timing, the **response headers**
(so you can see `Cache-Control: immutable` on a complete feed page vs `no-store`
on the head), the **ETag**, and the body. It's a tiny built-in Postman tuned to
teach the library's HTTP model:

- **Head:** after a `200`, a one-click **“Resend with If-None-Match”** replays
  the poll with the ETag and shows the **`304 Not Modified`** an unchanged head
  returns.
- **Feed:** **prev / next** buttons read the `prev`/`next` links out of the
  response and set the `from` cursor, so you can walk the paginated log by hand.
- **Append:** a prefilled, ready-to-fire body (fire it twice → `alreadyCommitted`).

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST`   | `/streams/chat:general/events` | **raw append** — client-built events (idempotent) |
| `GET`    | `/streams/chat:general/events?from=` | the library's paginated feed |
| `GET`    | `/streams/chat:general/head` | the pollable head resource (ETag / 304) |
| `GET`    | `/api/store` · `/api/store/object?key=` | Storage view — list / read raw R2 objects |
| `DELETE` | `/api/store` | reset — wipe the bucket + flush cached feed pages |

The first three are the library's own append / feed / head primitives; the
`/api/store` routes read the R2 bucket directly (bypassing the library) to power
the Storage view. Plus `POST /login` + `POST /logout`.

## Storage view — the raw objects in S3

The **🗄️ Storage** link opens `/store` — it lists every object in the R2 bucket
and shows each one's bytes **verbatim** (with an optional JSON pretty-print).
This is the payoff: the chat is nothing but immutable JSON files in object
storage:

```
chat/streams/chat:general/e/000000000000.json   ← commit (one per append)
chat/streams/chat:general/e/000000000001.json
...
chat/streams/chat:general/c/000000000000.json   ← chunk (a compacted bucket)
chat/streams/chat:general/head.json             ← head pointer
```

**Compaction** is wired via the library's write-driven trigger: when an append
seals a bucket (`compactionSuggested`), the endpoint fires
`store.compactStream()` in the background with `ctx.waitUntil` — the same
invocation keeps running after the response. Once the head passes a `chunkSize`
(5) boundary you'll watch the five `e/…` commit objects for that bucket collapse
into a single `c/…` **chunk** object here; reads serve from it transparently.

A **🗑 Delete bucket & flush caches** button resets the demo: it deletes every
object (`DELETE /api/store`) and purges the edge-cached complete feed pages.
Because a reset reuses version numbers, the chat fetches feed pages with
`cache: 'no-store'`, so a stale browser copy can never shadow a fresh read.

## The library's HTTP read model

Feed pages are the library's HTTP egress wire format (DESIGN.md, "HTTP reads"):

```jsonc
{ "streamId", "from", "to", "complete", "events": [...], "prev": <url|null>, "next": <url|null> }
```

- A **complete** page never changes, is served `Cache-Control: immutable`, and
  the feed endpoint stores it in the edge cache (`caches.default`) — a repeat
  request is a real cache hit that never touches R2. The **head** page is `no-store`.
- Navigate by following `prev`/`next`; a non-aligned `?from=3` **308-redirects**
  to its canonical page URL so every client requests identical URLs.
- To find the live tail, poll the **head resource** (`GET …/head`): `{ version,
  head, etag }`, `no-store`. Send its `etag` as `If-None-Match` → **`304`** when
  unchanged. When `version` moves, follow `head` into the paging space.

The **🔌 API browser** (`/api`) lets you exercise all of this interactively —
response headers, the ETag `304` round-trip, prev/next paging, and a
fetch-head-page button.

### The library helpers (contributed upstream)

This isn't hand-rolled in the demo — the HTTP read model lives in the
**`@jimvella/s3-event-store`** library itself (`src/http.ts`, **published as
`^0.2.0`**) and is consumed here as a normal dependency:

```ts
import { readPage, toWireFeed, canonicalFrom, readHead, toWireHead } from '@jimvella/s3-event-store';

const page = await readPage(store, 'chat:general', { from, pageSize: 5 });
const wire = toWireFeed(page, (from) => `${url.pathname}?from=${from}`);

const head = await readHead(store, 'chat:general', { pageSize: 5 });
const wireHead = toWireHead(head, (from) => `/streams/chat:general/events?from=${from}`);
```

- `readPage` computes the page window, `complete` flag, and `prev`/`next`
  cursors; `toWireFeed` renders the cursors into links in the caller's URL space.
- `readHead` resolves the pollable head resource with an ETag; `toWireHead`
  links its `head` cursor into the same paging space.
- `canonicalFrom` powers the redirect-to-canonical.

Endpoints: `src/routes/streams/[stream]/events/+server.ts` (`GET` feed +
`POST` raw append) and `.../head/+server.ts` (head). Page size defaults to the
store's `chunkSize` (set to **5** in `getStore`, so pages align to chunk
boundaries automatically). The `POST` uses `idempotentAppend` — see the
raw-append write model above.

## Project layout

The demo is deliberately small — the chat, two lens pages (API + Storage), and
the library's own endpoints.

```
src/
  lib/
    types.ts               shared read-model + event-data types
    server/store.ts        store wiring (chunkSize 5), projection, raw-append ingress, edge-cache helpers
    server/browser.ts      raw R2 access for the Storage view (list / get / wipe)
  routes/
    +layout.server.ts      require a username (redirect to /login otherwise)
    +page.svelte           the chat UI (Svelte 5 runes) — reads via head+feed, writes via append
    +page.server.ts        initial projection load
    api/+page.svelte       the API browser (interactive endpoint catalog)
    store/                 the Storage view (raw R2 objects + reset button)
    streams/[stream]/events/+server.ts  GET feed (readPage, edge-cached) + POST raw append (idempotentAppend)
    streams/[stream]/head/+server.ts    GET pollable head resource (readHead)
    api/store/             GET list · GET object · DELETE wipe+flush
    login/ , logout/       pick / clear the username cookie
wrangler.jsonc             R2 binding `EVENTS` + Worker config
```

## Run locally

```sh
npm install
npm run dev
```

Open the printed URL (e.g. http://localhost:5173). The R2 bucket is **emulated
on disk** by wrangler under `.wrangler/` — no Cloudflare account or real bucket
is needed for local dev. Open a second browser profile / incognito window to
chat as another user and watch messages sync via polling.

## Deploy to Cloudflare

```sh
# one-time: create the R2 bucket named in wrangler.jsonc
npx wrangler r2 bucket create s3-event-store-chat

npm run deploy   # builds and runs `wrangler deploy`
```

The bucket name is set in `wrangler.jsonc` (`r2_buckets[].bucket_name`); change
it there if you want a different name.

## Notes & limitations (it's a demo)

- Single global room; no real auth; live updates are polling (not WebSockets).
- Authorization trusts the username cookie — fine for a demo, not for production.
- The library's encryption and crypto-shredding features are not exercised here;
  see the [upstream README](https://github.com/jimvella/s3-event-store).

## License

MIT — see [LICENSE](./LICENSE).

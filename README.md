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

Message text is **field-level encrypted** under a per-user key, and users can
**crypto-shred** themselves: destroy the key and every copy of their words —
in the log, in backups, in immutable edge caches — becomes permanently
unreadable. See [Field-level encryption & crypto-shredding](#field-level-encryption--crypto-shredding).

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
  **short-polls** the **head resource** (`GET /streams/chat:general/head`) every
  ~1.5s. That response is served `Cache-Control: public, max-age=1`, so
  Cloudflare **edge micro-caches** it: a burst of polls within any 1s window is
  served from the edge — **no Worker invocation, no R2 read** — so origin cost
  stays flat no matter how many clients poll. Appends purge the entry so a new
  head shows up within a poll interval. When the head has moved past the client's
  cursor it walks **feed pages** (`GET …/events?from=<cursor>`) up the `next`
  chain and folds the envelopes into its local read model — the poll-head →
  follow-into-pages flow the library is built for. Own messages are folded
  straight from the append response (`nextExpectedVersion`), so they appear
  instantly; other people's carry ~1–2s (poll interval + cache TTL). Polling is
  suspended while the tab is hidden (Page Visibility API) and resumes with an
  immediate sync on return. See the cost reasoning in the git history — edge
  micro-caching decouples both Worker and R2 cost from client count, which a held
  long-poll can't.

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
| `GET`    | `/streams/chat:general/events?from=` | the library's paginated feed (ciphertext out) |
| `GET`    | `/streams/chat:general/head` | the pollable head resource (ETag / 304) |
| `GET`    | `/keys/{username}/keyring` | keyring delivery — decryption keys, `no-store` |
| `POST`   | `/api/keys/rotate` | mint your next key generation |
| `POST`   | `/api/shred` · `/api/shred/cancel` | request / cancel crypto-shredding of your account |
| `POST`   | `/api/shred/sweep` | run the shred sweeper (a cron in production) |
| `GET`    | `/api/store` · `/api/store/object?key=` | Storage view — list / read raw R2 objects |
| `DELETE` | `/api/store` | reset — wipe the bucket + flush cached feed pages |

The first three are the library's own append / feed / head primitives, and the
key/shred routes are thin wrappers over its key layer (`keyring`, `rotate`,
`requestShred`/`cancelShred`/`sweepShreds`); the `/api/store` routes read the
R2 bucket directly (bypassing the library) to power the Storage view. Plus
`POST /login` + `POST /logout`.

## Storage view — the raw objects in S3

The **🗄️ Storage** link opens `/store` — it lists every object in the R2 bucket
and shows each one's bytes **verbatim** (with an optional JSON pretty-print).
This is the payoff: the chat is nothing but immutable JSON files in object
storage:

```
chat/streams/chat:general/e/000000000000.json      ← commit (one per append)
chat/streams/chat:general/e/000000000001.json
...
chat/streams/chat:general/c/000000000000.json      ← chunk (a compacted bucket)
chat/streams/chat:general/head.json                ← head pointer
chat/streams/$system.key-audit/e/…                 ← key/shred audit stream
keystore/keys/{subject}/000000.json                ← wrapped data key, one per generation
keystore/tombstones/{subject}.json                 ← shred state machine
keystore/sweep/checkpoint.json                     ← the shred sweeper's cursor
```

**Compaction** is wired via the library's write-driven trigger: when an append
seals a bucket (`compactionSuggested`), the endpoint fires
`store.compactStream()` in the background with `ctx.waitUntil` — the same
invocation keeps running after the response. Once the head passes a `chunkSize`
(5) boundary you'll watch the five `e/…` commit objects for that bucket collapse
into a single `c/…` **chunk** object here; reads serve from it transparently.

A **🗑 Delete bucket & flush caches** button resets the demo: it deletes every
object (`DELETE /api/store`) — including the key store and all shred
tombstones — and purges the edge-cached complete feed pages. Because a reset
reuses version numbers, the chat fetches feed pages with `cache: 'no-store'`,
so a stale browser copy can never shadow a fresh read.

## Field-level encryption & crypto-shredding

The event log is append-only and its complete feed pages are cached
`immutable` at the edge — nothing can ever be rewritten or reliably purged. So
how do you erase someone? You don't delete the data; you **destroy the key it
was encrypted under** (crypto-shredding). This demo exercises the library's
key layer end to end, with one demo-owned twist:

- **Field-level encryption (demo-owned).** The library ships a *whole-payload*
  encrypting serializer keyed per **stream** — the right shape when each
  stream has one owner. A shared chat room is the other shape: one stream,
  many authors. So the demo implements a small **field-level serializer** on
  the library's public `PayloadSerializer` seam (`src/lib/server/fieldCrypto.ts`):
  only `text` is encrypted (AES-256-GCM, fresh random 96-bit nonce, AAD
  binding the ciphertext to its stream + field), under the **author's** key,
  with the key generation recorded per field:

  ```jsonc
  { "messageId": "…", "username": "alice",
    "text": { "$enc": "AES-256-GCM", "keyId": "000000", "iv": "…", "ct": "…" } }
  ```

  `username` and `messageId` stay plaintext, so authorization and the
  projection never need a key — and shredding one author erases exactly their
  words, nobody else's.

- **Key subjects are keyed hashes, not usernames.** Identifiers in object
  keys and audit events live forever *outside* the encryption boundary, so
  they must not be PII: the subject is `HMAC-SHA-256(pepper, username)`
  (truncated to 128 bits) under a server-held pepper — deterministic for key
  lookup, non-reversible even by dictionary. Clients never see subjects; the
  keyring route takes a username and maps it server-side.

- **Key management lives under a prefix of the same bucket.** The library's
  `createS3KeyStore` takes any `StorageDriver`, so a ~25-line prefix-rebasing
  wrapper (`prefixedDriver` in `src/lib/server/keys.ts`) roots it at
  `keystore/` next to `chat/`: wrapped per-generation data keys, the shred
  tombstones, and the sweeper's checkpoint — all visible in the Storage view.
  Keys are stored **wrapped** by a master key (`aesMasterKey`), so reading the
  key objects discloses nothing. (KEYS_DESIGN.md wants a separately-configured
  bucket where only the sweeper's principal may delete; a single Worker
  binding can't express that IAM split — noted as a demo simplification.)

- **Reads are model B: the browser decrypts.** This is the load-bearing
  choice. If the server decrypted, plaintext would sit in edge caches that
  serve immutable pages *forever* — the exact erasure failure shredding
  exists to prevent. Instead the feed serves stored ciphertext verbatim (the
  serializer's `deserialize` is a passthrough), and the chat fetches each
  author's keyring (`GET /keys/{username}/keyring`, `no-store`), imports the
  keys with WebCrypto, and decrypts locally. Decryption **fails closed**: a
  message whose key can't be delivered renders as
  *“🔒 Erased — the author's encryption key has been destroyed”*, never as
  stale plaintext or garbage.

- **The shred workflow is the library's, verbatim.** `POST /api/shred` calls
  `requestShred`: a `ShredRequested` **intent** is appended to the
  `$system.key-audit` stream first, then the tombstone (`pending`) is written.
  From that instant the subject is **soft-deleted** — keyring delivery
  returns empty (their messages go unreadable everywhere within a keyring
  refresh), new appends fail closed with **410** (`currentKey` throws
  `SubjectErasedError` before anything is stored), and their username is
  barred from login. Nothing is destroyed yet: `POST /api/shred/cancel`
  during the waiting period brings everything back. The **sweeper**
  (`POST /api/shred/sweep` — a button here, a cron in production) executes
  the hard delete once the waiting period (60s in the demo,
  `SHRED_WAITING_PERIOD_MS`) has elapsed: tombstone CAS to `committing`, key
  objects deleted, `ShredCompleted` appended. After that the ciphertext still
  sitting in R2, in the edge cache, and in any backup is permanently
  meaningless — and the tombstone is never removed, so the identity can't be
  reincarnated to write new personal data.

The **🔑 Keys** page is the lens on all of it: per-user key generations
(wrapped-key preview, object paths), tombstone states with a waiting-period
countdown, rotate / shred / cancel / sweep buttons, and the audit stream
rendered as a table. A good demo script:

1. Post as **alice** and **bob**; open Storage and see `text` as ciphertext
   envelopes and wrapped keys under `keystore/keys/…`.
2. Delete one of alice's messages — it vanishes from the UI, but the
   ciphertext is still in the log and the edge cache. *Delete hides; it
   doesn't erase.*
3. As alice, hit **Request shred**: every alice message everywhere renders
   erased within seconds, posting returns 410, and `ShredRequested` lands on
   the audit stream. Run the sweeper early — alice shows up in
   `openSubjects`, untouched. **Cancel** — her messages come back.
4. Shred again, wait out the 60s, run the sweeper: `keystore/keys/{alice}/…`
   disappears from the bucket, `ShredCompleted` lands, and the log's
   ciphertext is now permanently unreadable. Log out — the username is burned.
5. As bob, **Rotate key**: gen `000001` appears; his old messages decrypt
   under `000000`, new ones carry `keyId: "000001"` — generational keys,
   visible per field.

**Secrets.** Local dev falls back to published constants so `npm run dev`
works with zero setup. A real deployment must set both:

```sh
# 32 random bytes, base64 — wraps every data key
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY_SECRET
# any high-entropy string — keys the username → subject hash
openssl rand -base64 32 | npx wrangler secret put SUBJECT_PEPPER
```

**Demo caveats, so the reference reads honestly:** keyring delivery is the
read-access-control point and here it's open to any logged-in user (everyone
can read the room anyway); the append ingress necessarily sees plaintext
before encrypting; and the key store shares one bucket/principal with the
events instead of the inverted-config bucket KEYS_DESIGN.md specifies.

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
    crypto.ts              field-envelope format + WebCrypto encrypt/decrypt (isomorphic)
    server/store.ts        store wiring (chunkSize 5, encrypting serializer), projection, raw-append ingress, edge-cache helpers
    server/fieldCrypto.ts  the field-level encrypting serializer (PayloadSerializer seam)
    server/keys.ts         key store under keystore/ (prefixedDriver), subject hashing, shred context
    server/browser.ts      raw R2 access for the Storage view (list / get / wipe)
  routes/
    +layout.server.ts      require a username (redirect to /login otherwise)
    +page.svelte           the chat UI (Svelte 5 runes) — reads via head+feed, decrypts locally, writes via append
    +page.server.ts        initial projection load (ciphertext through)
    api/+page.svelte       the API browser (interactive endpoint catalog)
    store/                 the Storage view (raw R2 objects + reset button)
    keys/+page.svelte      the Keys view (generations, tombstones, shred/rotate/sweep, audit log)
    keys/[username]/keyring/+server.ts  GET keyring delivery (model B, no-store)
    streams/[stream]/events/+server.ts  GET feed (readPage, edge-cached) + POST raw append (idempotentAppend)
    streams/[stream]/head/+server.ts    GET pollable head resource (readHead)
    api/store/             GET list · GET object · DELETE wipe+flush
    api/shred/             POST request · cancel/ · sweep/   (the shred workflow)
    api/keys/rotate/       POST mint the next key generation
    login/ , logout/       pick / clear the username cookie (login rejects shredded names)
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
- The encryption/shredding caveats listed under
  [Field-level encryption & crypto-shredding](#field-level-encryption--crypto-shredding):
  open keyring delivery, shared key/event bucket, dev-fallback secrets. The
  demo's field-level serializer is demo-owned; the library's own (shipped)
  encryption is whole-payload — see the
  [upstream README](https://github.com/jimvella/s3-event-store).

## License

MIT — see [LICENSE](./LICENSE).

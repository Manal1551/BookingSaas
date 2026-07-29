# Booking API Reference (Week 2)

Base URL is per-tenant: the API lives on the tenant **subdomain** so the server
can resolve the tenant from the host. In dev this project uses `lvh.me` (which
resolves to `127.0.0.1` automatically, no hosts-file edit needed):
`http://<slug>.lvh.me:5000` (e.g. `http://acme.lvh.me:5000`) — match it to your
`ROOT_DOMAIN`. Auth is cookie-based (httpOnly); a browser or a cookie-jar
client sends `access_token` automatically after login. Scripts may instead send
`Authorization: Bearer <accessToken>`.

All `/api/bookings/*` routes run `resolveTenant` + `requireAuth`. A request to
the bare root domain (no subdomain) returns `400`; an unknown tenant `404`;
missing/expired auth `401`; a token minted for another tenant `403`.

> **Scope note.** The error envelope below applies to `/api/bookings/*` only.
> Week 1 routes (`/api/auth/*`, `/api/tenants/*`) keep their original
> `{ "error": "message" }` shape — the booking router mounts its own error
> handler so Week 1 behaviour is untouched.

---

## 1. Error envelope

Every non-2xx booking response, without exception:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request failed validation.",
    "details": [
      { "path": "body.startAt", "message": "Must be in the future" }
    ],
    "requestId": "req_mdx8p2k1a3f9c7e2"
  }
}
```

- `code` — machine-readable, from the closed union below.
- `message` — safe to show a user. `5xx` is always generic; internals, stack
  traces and raw driver errors never reach the client.
- `details` — present on validation failures. `path` is absolute
  (`body.*`, `query.*`, `params.*`, `headers.*`) so a client can map an error
  straight onto the input that caused it.
- `requestId` — also returned in the `X-Request-Id` response header on **every**
  request. Quote it when reporting a problem. A caller-supplied `X-Request-Id`
  is honoured if it is ≤64 URL-safe characters.

### Error codes

| Code | HTTP | When |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Body/query/params/header failed a Zod rule; also "no tenant subdomain" |
| `UNAUTHORIZED` | 401 | Missing, invalid or expired token |
| `FORBIDDEN` | 403 | Token belongs to a different tenant |
| `NOT_FOUND` | 404 | Unknown tenant, unknown booking, or unmatched booking path |
| `BOOKING_CONFLICT` | 409 | The resource is already booked for part of the window |
| `IDEMPOTENCY_KEY_REUSE` | 409 | Key already used with a *different* request body |
| `REQUEST_IN_PROGRESS` | 409 | An identical request with that key is still running |
| `STALE_RESOURCE` | 409 | `If-Match`/`version` no longer matches the stored booking |
| `RATE_LIMITED` | 429 | More than 120 booking requests in a minute |
| `INTERNAL_ERROR` | 500 | Unexpected server fault |

---

## 2. The booking object

```json
{
  "id": "665f1c2a9b1e4d3f2a7c8b01",
  "customerName": "Ada Lovelace",
  "customerEmail": "ada@example.com",
  "serviceName": "Design consultation",
  "resourceId": "room-1",
  "startAt": "2026-08-01T10:00:00.000Z",
  "endAt": "2026-08-01T11:00:00.000Z",
  "notes": "",
  "status": "pending",
  "version": 0,
  "createdAt": "2026-07-27T09:12:44.001Z",
  "updatedAt": "2026-07-27T09:12:44.001Z"
}
```

`status` ∈ `pending | confirmed | cancelled | completed`.
`version` is the optimistic-concurrency token — echo it back on `PATCH`.

### Validation rules

These live in `server/src/validation/booking.schemas.js` and are the **single
source of truth**: the browser imports the very same module (through the
`@shared` Vite alias), so client and server can never disagree.

| Field | Rule |
| --- | --- |
| `customerName` | required, 1–120 chars |
| `customerEmail` | required, valid email, ≤200 chars |
| `serviceName` | required, 1–160 chars |
| `resourceId` | required, 1–64 chars, `[A-Za-z0-9][A-Za-z0-9._-]*` |
| `startAt` / `endAt` | required, ISO 8601, **aligned to a 5-minute boundary** |
| — | `endAt` strictly after `startAt` |
| — | duration ≤ **8 hours** |
| — | `startAt` must be in the future (POST only) |
| `notes` | optional, ≤2000 chars, defaults to `""` |
| `status` | optional enum, defaults to `pending` |

All schemas are `.strict()` — unknown keys are rejected with `400`, never
silently dropped.

**Why the 5-minute grid?** It is what makes double-booking preventable *in the
database* (§4). Requiring aligned input means the grid can never report a
conflict between two bookings that do not actually overlap.

---

## 3. Idempotency

### The contract

`POST /api/bookings` **requires** an `Idempotency-Key` header containing a
UUID. A missing or malformed key is a `400 VALIDATION_ERROR` with
`details[0].path = "headers.Idempotency-Key"`.

Generate the key **once per booking intent** and reuse it for every retry of
that submission. The web client generates one per form session and only
regenerates it after a successful save or a reset.

### Behaviour

| Call | Result |
| --- | --- |
| First call with a key | Processed normally; the response is stored. `201` |
| Repeat, **same** body | The **stored** response is returned verbatim, nothing is re-executed. Original status + `Idempotent-Replay: true` |
| Repeat, **different** body | `409 IDEMPOTENCY_KEY_REUSE` |
| Repeat **while the first is still running** | `409 REQUEST_IN_PROGRESS` |
| After 24h | The key expires (TTL index) and behaves as new |

Keys are scoped per tenant — two tenants may use the same UUID independently.

### How it is made atomic without transactions

This deployment targets **standalone MongoDB**, which has no multi-document
transactions. Atomicity comes from a unique index instead, in three phases
(`server/src/services/idempotency.js`):

1. **Claim** — insert the key as `in_progress`. The unique
   `{ tenantId, key }` index decides the winner of any race; there is no
   read-then-write window. A losing insert reads the existing record to decide
   between replay, `IDEMPOTENCY_KEY_REUSE` and `REQUEST_IN_PROGRESS`.
2. **Execute** — create the booking.
3. **Record** — update the key to `completed`, storing the exact status and
   body that were sent, so replays are byte-identical.

If step 2 fails, the key record is **deleted**, so a corrected retry may reuse
the same key. The trade-off is deliberate: only successful responses are
replayable, and a failed attempt does not burn a key.

The `fingerprint` is `sha256` over the canonicalised (key-sorted) request body
plus method, path, tenantId and userId.

---

## 4. Double-booking prevention

Two bookings for the same `resourceId` may not overlap in time. This is
enforced **by the database**, not by an application check.

MongoDB has no range-exclusion constraint (Postgres would use
`EXCLUDE USING gist (resource_id WITH =, tstzrange(start_at, end_at) WITH &&)`),
so overlap is reduced to uniqueness over discrete slots:

- Each booking is expanded into the 5-minute grid slots it occupies, stored as
  the `slotKeys` array (`server/src/utils/slots.js`).
- A **unique multikey** index on `{ tenantId, resourceId, slotKeys }` therefore
  rejects any two bookings that share a slot.
- The index is **partial** (`status ∈ pending|confirmed|completed`), so a
  cancelled booking drops out of the index and releases its slots.

The range is half-open `[start, end)`, so a 10:00–10:30 and a 10:30–11:00
booking are back-to-back, not conflicting. A violation surfaces as
`409 BOOKING_CONFLICT`.

---

## 5. Optimistic concurrency

`PATCH` requires the version you loaded, via either:

- `If-Match: "3"` header (quoted or bare; `W/` prefix tolerated), **or**
- a `version` field in the JSON body.

The update is applied with `findOneAndUpdate({ _id, __v: version })`, so it
only lands if nobody else has written since. A mismatch is
`409 STALE_RESOURCE`, and the UI offers to reload rather than clobber.
`GET /api/bookings/:id` also returns an `ETag`.

---

## 6. Endpoints

### `GET /api/bookings`

Lists bookings for the current tenant.

| Param | Type | Notes |
| --- | --- | --- |
| `from` | ISO datetime | `startAt >= from` |
| `to` | ISO datetime | `startAt < to`; must be after `from` |
| `status` | enum | Filter by status |
| `resourceId` | string | Filter by resource |
| `page` | int ≥1 | Default `1` |
| `limit` | int 1–200 | Default `100` |
| `sort` | `startAt` \| `-startAt` \| `createdAt` \| `-createdAt` | Default `startAt` |

```json
{
  "bookings": [ /* Booking[] */ ],
  "page": 1, "limit": 100, "total": 3, "totalPages": 1, "hasMore": false
}
```

### `POST /api/bookings`

Headers: `Idempotency-Key: <uuid>` (**required**).

```json
{
  "customerName": "Ada Lovelace",
  "customerEmail": "ada@example.com",
  "serviceName": "Design consultation",
  "resourceId": "room-1",
  "startAt": "2026-08-01T10:00:00.000Z",
  "endAt": "2026-08-01T11:00:00.000Z",
  "notes": "optional",
  "status": "pending"
}
```

- `201 { "booking": {…} }` on create.
- `201 { "booking": {…} }` + `Idempotent-Replay: true` on replay.
- `409` — `BOOKING_CONFLICT`, `IDEMPOTENCY_KEY_REUSE` or `REQUEST_IN_PROGRESS`.

### `GET /api/bookings/:id`

`200 { "booking": {…} }` (with `ETag`) or `404 NOT_FOUND`.

### `PATCH /api/bookings/:id`

Partial update; body is strict and every field optional, but at least one must
be present. Requires `If-Match` or `version` (§5). When `startAt` is being
moved the future-dated rule applies; otherwise a past booking can still have
its notes or status edited. Returns `200 { "booking": {…} }`.

### `DELETE /api/bookings/:id`

Always **`204 No Content`** — deleting an already-deleted (or never-existing)
booking is success, not `404`. Repeat calls never error.

---

## 7. Try it

- Import [`bookings.postman_collection.json`](./bookings.postman_collection.json).
  Set the `baseUrl` variable (default `http://acme.lvh.me:5000`) to match your
  `ROOT_DOMAIN`, run **Auth → Login**, then the Bookings requests. A
  collection-level pre-request script generates a fresh `Idempotency-Key` UUID
  for every send; the **Failure modes** folder pins a fixed key so replay and
  reuse can be demonstrated.
- Automated end-to-end check: `npm run seed` then `npm run verify:bookings`.
- Test suites: `npm test` in `server/` (32 integration + 22 schema tests) and
  in `client/` (7 form component tests).

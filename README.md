# Multi-Tenant Booking SaaS (MERN) — Weeks 1–3

A production-shaped multi-tenant SaaS on the MERN stack: **tenancy and auth**
(Week 1), a **conflict-free booking API and calendar UI** (Week 2), and
**Stripe subscription billing** (Week 3).

## 1. Overview

Each customer ("tenant") gets its own subdomain (`acme.lvh.me`), and every
piece of tenant data is isolated at the **document level** — enforced in the
application layer, not left to convention.

| Week | Delivers |
|---|---|
| **1** | Shared-collection tenancy, subdomain routing, JWT auth with per-tenant token binding, seeded database, dashboard shell |
| **2** | Booking API with idempotent creates, DB-level double-booking prevention, optimistic concurrency, typed error envelope, calendar UI |
| **3** | Stripe subscriptions, signature-verified webhooks with duplicate + out-of-order handling, pricing page, Checkout flow, billing history, plan upgrade/downgrade, plan-limit enforcement |

Each week is **additive**: Week 2 mounts its own middleware stack on
`/api/bookings/*` and Week 3 on `/api/billing/*`, so Week 1's routes keep their
original behaviour and response shapes untouched. That constraint is visible in
the code (per-router error handlers rather than one global one) and is verified
by the test suite — Week 2's 54 tests still pass unchanged.

**Current state:** 120 server tests + 24 client tests passing, client builds
clean. Billing is fully implemented but ships with Stripe keys blank; see
section 12 to switch it on.

## Quick start

```bash
npm install
npm run sync:indexes     # build DB indexes (required once after pulling Week 3)
npm run seed             # 3 tenants + users
npm run dev              # client + server
```

Open **`http://acme.lvh.me:5173/dashboard`**, log in as `alice@acme.test` /
`Password123!`. `lvh.me` resolves to `127.0.0.1` automatically — no hosts-file
edit needed. Full detail in section 5; Stripe setup in section 12.

## 2. Approach — why shared-collection tenancy

MongoDB has no built-in Row-Level Security like Postgres, and its native RBAC
operates at the **database/collection** level, which is too coarse for a
shared-collection design. We chose the **shared-database, shared-collection**
pattern with document-level isolation:

- Every tenant-scoped document carries a required `tenantId`.
- A Mongoose plugin (`tenantScopePlugin`) transparently injects `tenantId` into
  every query and stamps it onto every write, reading the current tenant from a
  **request-scoped `AsyncLocalStorage` context** (never a global variable — a
  global would leak between concurrent requests).

**Why not database-per-tenant?**

| | Shared collection (chosen) | DB-per-tenant |
|---|---|---|
| Isolation strength | Logical, app-enforced | Physical, strong |
| Operational cost | One DB to run/backup/migrate | N DBs, N migrations |
| Onboarding a tenant | Insert a row | Provision a database |
| Cross-tenant analytics | Easy (one query) | Hard (fan-out) |
| Blast radius of a bug | Higher — isolation is code | Lower |

For an early-stage SaaS the operational simplicity wins, provided the isolation
code is centralized, tested, and **fail-closed** (a query with no tenant in
context throws rather than returning everything). That is exactly what the
plugin does. The tradeoff is documented honestly: isolation is only as strong
as the plugin, which is why `verify-isolation.js` exists to prove it.

## 3. Tech stack

| Choice | Used for | Why |
|---|---|---|
| React 18 + Vite | Frontend | Fast dev server, native subdomain host support |
| React Router v6 | Routing | Root-domain vs tenant-subdomain route split |
| TailwindCSS | Styling | Consistent SaaS UI without bespoke CSS |
| Node + Express | API | Ubiquitous, middleware-friendly |
| MongoDB + Mongoose | Database | Plugin/query-middleware hooks power tenant scoping |
| AsyncLocalStorage | Tenant context | Per-request isolation without globals |
| JWT + bcrypt | Auth | Stateless access/refresh tokens; 12-round hashing |
| zod | Env + input validation | Fail-fast config, validated request bodies |
| helmet, express-rate-limit, CORS | Security | Headers, brute-force limits, locked origins |
| Docker Compose | Local dev DB | One-command Mongo + mongo-express UI |
| **Stripe** (SDK v22) | Payments (Week 3) | Hosted Checkout keeps card data off our servers (PCI SAQ-A); Billing Portal replaces a bespoke payment-method UI |
| **TanStack Query** | Server state (Weeks 2–3) | Cache invalidation + polling, which is what makes webhook-driven UI updates work |
| **react-hook-form** | Forms (Week 2) | Uncontrolled inputs, and maps server `details[]` back onto fields |
| **FullCalendar** | Booking calendar (Week 2) | Month/week/day views without building a date grid |
| **node:test + supertest** | Server tests | Zero extra runtime deps; real HTTP against a real in-memory Mongo |
| **Vitest + Testing Library** | Client tests | Shares the Vite config, so tests resolve the same shared schemas |

## 4. Folder structure

Files are marked `¹` `²` `³` by the week that introduced them.

```
/
├── package.json                    # workspaces + scripts
├── docker-compose.yml              # mongo + mongo-express (local dev)
├── README.md                       # this file
├── server/
│   ├── .env.example
│   ├── docs/
│   │   ├── API.md                  # ² Booking API reference
│   │   ├── BILLING.md              # ³ Billing + webhook reference
│   │   └── bookings.postman_collection.json   # ²
│   ├── scripts/
│   │   ├── seed.js                 # ¹ 3 tenants + users, idempotent
│   │   ├── verify-isolation.js     # ¹ proves cross-tenant access is rejected
│   │   ├── verify-bookings.js      # ² proves idempotency + overlap guards
│   │   ├── sync-indexes.js         # ² reconciles indexes, drops stale ones
│   │   └── setup-stripe-prices.js  # ³ creates Stripe products/prices
│   ├── tests/
│   │   ├── booking.validation.test.js   # ²
│   │   ├── bookings.integration.test.js # ² 54 tests
│   │   ├── billing.webhook.test.js      # ³ 26 — real signature verification
│   │   ├── billing.api.test.js          # ³ 22 — runs with NO Stripe keys
│   │   └── billing.limits.test.js       # ³ 18 — plan enforcement
│   └── src/
│       ├── config/
│       │   ├── env.js              # ¹ zod-validated env, fails fast
│       │   ├── db.js               # ¹ connection (+ SRV DNS workaround)
│       │   └── plans.js            # ³ THE pricing catalog
│       ├── models/
│       │   ├── Tenant.js           # ¹ (+³ plan, stripeCustomerId)
│       │   ├── User.js             # ¹
│       │   ├── Booking.js          # ² slotKeys + unique overlap index
│       │   ├── IdempotencyKey.js   # ² two-phase idempotency ledger
│       │   ├── Subscription.js     # ³ local mirror of Stripe
│       │   ├── Invoice.js          # ³ billing history
│       │   └── WebhookEvent.js     # ³ dedupe ledger (NOT tenant-scoped)
│       ├── middleware/
│       │   ├── resolveTenant.js    # ¹ subdomain -> tenant + ALS context
│       │   ├── requireAuth.js      # ¹ JWT + tenant cross-check
│       │   ├── tenantScopePlugin.js# ¹ document-level isolation
│       │   ├── errorHandler.js     # ¹ flat { error: "msg" }
│       │   ├── validate.js         # ² zod wrapper
│       │   ├── requestId.js        # ² X-Request-Id
│       │   ├── bookingErrorHandler.js # ² typed envelope (reused by ³)
│       │   └── enforcePlanLimits.js   # ³ plan caps on booking creation
│       ├── services/
│       │   ├── idempotency.js      # ² insert-first, unique-index protocol
│       │   ├── stripe.js           # ³ lazy client + error translation
│       │   ├── billing.js          # ³ checkout, portal, plan change, cancel
│       │   ├── billingSync.js      # ³ ONLY writer of billing state
│       │   ├── webhookEvents.js    # ³ claim/complete/fail an event
│       │   └── entitlements.js     # ³ usage counting + limit checks
│       ├── routes/                 # auth¹ tenant¹ booking² billing³ webhook³
│       ├── controllers/            # auth¹ tenant¹ booking² billing³ webhook³
│       ├── validation/             # booking.schemas² billing.schemas³
│       ├── utils/                  # tenantContext¹ tokens¹ appError² slots²
│       ├── app.js                  # wiring — webhook mounted BEFORE json()
│       └── server.js               # boot
└── client/
    ├── .env.example
    ├── vite.config.js              # host + allowedHosts wildcard, @shared alias
    └── src/
        ├── pages/
        │   ├── Landing.jsx Login.jsx Register.jsx Dashboard.jsx   # ¹
        │   ├── Bookings.jsx        # ² calendar + list
        │   ├── Pricing.jsx         # ³ plans + Checkout flow
        │   └── Billing.jsx         # ³ subscription, usage, invoices
        ├── components/
        │   ├── Sidebar ProtectedRoute TenantContext DashboardLayout  # ¹
        │   ├── BookingForm BookingDetail BookingFilters Modal Toast  # ²
        │   ├── PlanCard.jsx        # ³ one pricing column + interval toggle
        │   ├── PlanChangeDialog.jsx# ³ proration quote before confirming
        │   ├── SubscriptionCard.jsx# ³ status, renewal, cancel/resume
        │   ├── InvoiceTable.jsx    # ³ history (table / cards)
        │   ├── UsageMeters.jsx     # ³ consumption vs limits
        │   └── CheckoutStatusBanner.jsx # ³ the webhook-wait UI
        ├── hooks/                  # useBookings² useBilling³
        ├── lib/                    # api¹ bookingClient² bookingApi² billingApi³
        ├── App.jsx                 # routing
        └── main.jsx
```

## 5. Setup instructions

```bash
# 1. Install (npm workspaces installs client + server)
npm install

# 2. Configure env
cp server/.env.example server/.env
cp client/.env.example client/.env
#   - Edit server/.env: set strong JWT_ACCESS_SECRET and JWT_REFRESH_SECRET
#     (must differ). Generate with:
#     node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
#   - MONGODB_URI already points at the Dockerized Mongo below. To use Atlas,
#     replace it with your mongodb+srv://... string.

# 3. Start the local database (Mongo + mongo-express UI on :8081)
npm run docker:up
#   ...or skip Docker and use an Atlas URI in server/.env instead.

# 4. Seed realistic data (3 tenants, users)
npm run seed

# 5. Build database indexes — REQUIRED once, and after any schema change.
#    Creates the Week 2 overlap/idempotency indexes and the Week 3 billing
#    ones, and drops any index the schemas no longer declare.
npm run sync:indexes

# 6. Seed realistic data (3 tenants, users)
npm run seed

# 7. (optional) Prove tenant isolation and the booking guarantees
npm run verify:isolation
npm run verify:bookings

# 8. Configure local subdomains — see section 8.
#    EASIEST: set ROOT_DOMAIN=lvh.me (server) and VITE_ROOT_DOMAIN=lvh.me
#    (client). `lvh.me` and every subdomain resolve to 127.0.0.1 already,
#    so there is nothing to edit in your hosts file.
#    Otherwise, for app.local, add to your hosts file:
#      127.0.0.1  app.local acme.app.local globex.app.local initech.app.local

# 9. Run client + server together
npm run dev
```

Then visit (using `lvh.me`; swap in `app.local` if you configured that):

- Root / signup:   `http://lvh.me:5173`
- Acme workspace:  `http://acme.lvh.me:5173`
- Bookings:        `http://acme.lvh.me:5173/dashboard/bookings`
- Plans:           `http://acme.lvh.me:5173/dashboard/plans`
- Billing:         `http://acme.lvh.me:5173/dashboard/billing`
- mongo-express:   `http://localhost:8081` (login `admin` / `admin`)

> **Billing is optional.** With the `STRIPE_*` vars blank the app runs
> normally — the pricing page shows the real catalog read-only and billing
> commands answer a clean `503`. Section 12 turns it on.

> If a required env var is missing or malformed, the server **exits immediately**
> with a message listing exactly which var is wrong (see `server/src/config/env.js`).
> The Stripe vars are the exception: they are optional by design.

### Every script, in one place

Run from the repo root.

| Command | What it does |
|---|---|
| `npm run dev` | Client + server together (ports 5173 / 5000) |
| `npm run dev:server` / `dev:client` | One side only |
| `npm run build` | Production client build |
| `npm run seed` | 3 tenants + users. Idempotent |
| `npm run sync:indexes` | Reconcile DB indexes with the schemas. **Run after pulling** |
| `npm run stripe:setup` | Create Stripe products/prices, print the env lines (Week 3) |
| `npm test` | Everything — server then client |
| `npm run test:server` | 120 tests (node:test + supertest + in-memory Mongo) |
| `npm run test:client` | 24 tests (Vitest + Testing Library) |
| `npm run verify:isolation` | Proves cross-tenant access is rejected |
| `npm run verify:bookings` | Proves idempotency + the overlap guard |
| `npm run docker:up` / `docker:down` | Local Mongo + mongo-express |

## 6. Seeded test accounts

All seeded accounts share the password **`Password123!`**.

| Tenant (subdomain) | Email | Role |
|---|---|---|
| `acme.app.local` | alice@acme.test | owner |
| `acme.app.local` | marcus@acme.test | admin |
| `acme.app.local` | priya@acme.test | member |
| `globex.app.local` | hank@globex.test | owner |
| `globex.app.local` | dana@globex.test | admin |
| `globex.app.local` | alice@acme.test | member ← same email as Acme's owner, different tenant |
| `initech.app.local` | bill@initech.test | owner |
| `initech.app.local` | peter@initech.test | admin |

The duplicated `alice@acme.test` proves the compound unique index on
`{ tenantId, email }`: the same email can exist independently in two tenants.

## 7. How tenant isolation works

Two independent layers:

**Layer 1 — automatic query scoping (`tenantScopePlugin` + `AsyncLocalStorage`).**
On each request, `resolveTenant` looks up the tenant by subdomain and runs the
rest of the request inside `tenantStorage.run({ tenantId, tenant }, next)`. The
Mongoose plugin attached to `User` (and any future tenant model) hooks query
middleware (`find`, `findOne`, `updateOne`, `deleteMany`, …) and merges the
current `tenantId` into the filter. Writes are stamped with the context
tenantId, and a write whose tenantId disagrees with context is rejected. If
**no** tenant is in context, queries **throw** — fail-closed, so a forgotten
scope can never silently return all tenants' data.

**Layer 2 — token/subdomain double-check (`requireAuth`).**
The JWT payload is `{ userId, tenantId, role }`. On every protected request,
`requireAuth` verifies the token *and* compares the token's `tenantId` to the
tenant resolved from the subdomain. **Mismatch = 403**, even for an otherwise
valid token. This stops a token stolen from `acme` being replayed against
`globex.app.local`.

`server/scripts/verify-isolation.js` demonstrates both: it logs in as an Acme
user, confirms `/me` works on Acme, then replays that token against Globex and
confirms a `403`; it also runs `User.find()` in each tenant's context and
asserts the result sets never overlap, and that a query with no context throws.

## 8. How subdomain routing works locally

Browsers must resolve `*.app.local` to your machine. Two options:

**Option A — hosts file (recommended).** Add these lines:

- macOS/Linux: edit `/etc/hosts`
- Windows: edit `C:\Windows\System32\drivers\etc\hosts` (as Administrator)

```
127.0.0.1   app.local
127.0.0.1   acme.app.local
127.0.0.1   globex.app.local
127.0.0.1   initech.app.local
```

**Option B — zero-config `lvh.me`.** `lvh.me` and all its subdomains already
resolve to `127.0.0.1` publicly, so no hosts edit is needed. Set
`ROOT_DOMAIN=lvh.me` in `server/.env` and `VITE_ROOT_DOMAIN=lvh.me` in
`client/.env`, and also update `CLIENT_ORIGIN_PATTERN=http://*.lvh.me:5173`.
Then visit `http://acme.lvh.me:5173`.

Vite is configured (`vite.config.js`) with `server.host` and
`server.allowedHosts` including `.${ROOT_DOMAIN}`, so tenant subdomains are
servable in dev. Express CORS (`utils/corsOrigin.js`) allows only the subdomain
pattern from `CLIENT_ORIGIN_PATTERN` (plus the bare root origin for signup),
never `*`.

## 9. API endpoints

| Method | Path | Domain | Auth | Description |
|---|---|---|---|---|
| GET | `/api/health` | any | — | Liveness check |
| GET | `/api/tenants/check-slug/:slug` | root | — | Is a subdomain available? |
| POST | `/api/tenants` | root | — | Create a tenant/workspace |
| POST | `/api/auth/register` | tenant | — | Register a user in the tenant |
| POST | `/api/auth/login` | tenant | — | Log in (per `{tenantId, email}`) |
| POST | `/api/auth/refresh` | tenant | refresh cookie | Rotate the access token |
| POST | `/api/auth/logout` | tenant | — | Clear auth cookies |
| GET | `/api/auth/me` | tenant | access cookie | Current user + tenant |
| GET | `/api/bookings` | tenant | access cookie | List bookings (`from`/`to`/`status`/`resourceId`/`page`/`limit`/`sort`) |
| POST | `/api/bookings` | tenant | access cookie | Create a booking — **requires** an `Idempotency-Key` UUID header |
| GET | `/api/bookings/:id` | tenant | access cookie | Get one booking |
| PATCH | `/api/bookings/:id` | tenant | access cookie | Partial update — requires `If-Match`/`version` |
| DELETE | `/api/bookings/:id` | tenant | access cookie | Delete a booking (always `204`, repeatable) |
| GET | `/api/billing/plans` | tenant | access cookie | Plan catalog + the tenant's current plan |
| GET | `/api/billing/subscription` | tenant | access cookie | Current subscription state |
| GET | `/api/billing/invoices` | tenant | access cookie | Billing history (`page`/`limit`/`status`) |
| GET | `/api/billing/usage` | tenant | access cookie | Consumption vs. the plan's limits |
| POST | `/api/billing/checkout` | tenant | owner/admin | Start a Stripe Checkout Session |
| POST | `/api/billing/portal` | tenant | owner/admin | Open the Stripe Billing Portal |
| GET | `/api/billing/preview` | tenant | owner/admin | Quote a plan switch (proration) |
| POST | `/api/billing/change` | tenant | owner/admin | Apply an upgrade/downgrade |
| POST | `/api/billing/cancel` | tenant | owner/admin | Cancel at period end |
| POST | `/api/billing/resume` | tenant | owner/admin | Undo a scheduled cancellation |
| POST | `/api/billing/sync` | tenant | owner/admin | Re-pull billing state from Stripe |
| POST | `/api/webhooks/stripe` | root | **signature** | Stripe events — verified, deduped, ordered |

"tenant" = must be called on a tenant subdomain; "root" = called on the bare
root domain. Tokens travel in `httpOnly` cookies (a `Bearer` header is also
accepted for scripts).

The webhook is the one route with no session and no subdomain: it is
authenticated solely by its Stripe signature, and is mounted **before**
`express.json()` so signature verification sees the raw bytes.

> **Error-shape note.** `/api/bookings/*` answers with the richer Week 2
> envelope `{ error: { code, message, details, requestId } }`; all Week 1
> routes keep the original `{ error: "message" }` shape. The booking router
> mounts its own error handler, so Week 1 behaviour is untouched.

**Booking API details** — full request/response shapes, the error-code table,
idempotency semantics and the double-booking constraint are documented in
[`server/docs/API.md`](server/docs/API.md). An importable Postman collection
lives at
[`server/docs/bookings.postman_collection.json`](server/docs/bookings.postman_collection.json).
See section 11 for how to run and test everything.

**Billing API details** — plan catalog, proration rules, the webhook security
model (signature verification, duplicate handling, out-of-order guards) and the
frontend reconciliation flow are documented in
[`server/docs/BILLING.md`](server/docs/BILLING.md). See section 12 to run it.

## 10. Known limitations / next steps

Project-wide gaps. Each week also lists its own scope decisions — see
[§11 *Intentionally not done*](#intentionally-not-done) for bookings and
[§12](#intentionally-not-done-2) for billing.

- **No email verification** — accounts are usable immediately on register.
- **No refresh-token revocation store** — logout clears cookies, but a stolen
  refresh token remains valid until it expires. A denylist/rotation store is the
  next step.
- **No password reset / forgot-password flow.**
- **No account lockout**, though every router now rate-limits
  (auth, bookings, billing, and a tighter cap on checkout).
- **Isolation is application-enforced** — strong only as long as every tenant
  model uses the plugin and no code bypasses it via `skipTenantScope`. A
  DB-per-tenant migration path is the escalation if a customer needs physical
  isolation.
- **Team and Settings remain navigation placeholders.** Roles are enforced
  server-side (`requireRole`) and seats are capped by plan, but there is no UI
  to invite or manage members.

**Now done, and previously listed here as missing:** bookings (Week 2 — an
idempotent CRUD API with DB-level double-booking prevention and a FullCalendar
UI) and billing (Week 3 — Stripe subscriptions with `Tenant.plan` derived from
webhooks and enforced on writes).

## 11. Week 2 — bookings: running and testing

### Run it

```bash
npm install
npm run docker:up          # Mongo
npm run seed               # tenants + users (does not create bookings)
npm run dev                # client + server
```

Then open **`http://acme.lvh.me:5173/dashboard/bookings`** and log in as
`alice@acme.test` / `Password123!`.

> The calendar only exists on a **tenant subdomain**. On `localhost` the app
> serves the marketing page and redirects everything else — that is by design
> (see section 8), not a bug.

### Test it

| Command | What it covers |
| --- | --- |
| `npm test` | Everything below, server then client |
| `npm run test:server` | 54 tests: 32 API integration (real MongoDB, in-memory) + 22 schema unit tests |
| `npm run test:client` | 7 component tests for the create form (validation + server-error mapping + idempotency-key reuse) |
| `npm run verify:bookings` | End-to-end proof against your **real** dev database |
| `npm run build` | Production client build |

`test:server` needs no running database — `mongodb-memory-server` downloads and
manages its own `mongod` (the first run downloads ~78 MB, later runs are
instant). `verify:bookings` needs `npm run docker:up` + `npm run seed` first.

> **Running against a database seeded by an earlier schema version?** Mongoose
> creates missing indexes but never drops obsolete ones, so a database from a
> pre-Week-2 build can still carry a stale unique `{ tenantId, idempotencyKey }`
> index on `bookings` that rejects concurrent inserts with `E11000` (surfacing
> as 500s under load). Run **`npm run sync:indexes`** once to reconcile every
> collection's indexes with the current schemas. It is safe to re-run and a
> no-op on an already-current database.

The integration suite proves the parts that are easy to claim and hard to do:
duplicate POSTs with one key create exactly **one** row and replay a
byte-identical response; five parallel duplicates still create exactly one;
a different body on the same key is `409`; overlapping bookings are rejected by
the database while back-to-back ones are allowed; `DELETE` twice is `204` both
times; and every Zod rule rejects with the right `details[].path`.

### Design decisions worth knowing

- **Idempotency without transactions.** Standalone Mongo has no multi-document
  transactions, so atomicity comes from a unique index: the key is inserted as
  `in_progress` *before* the booking is created, then updated to `completed`
  with the stored response. A failed attempt deletes its key so a corrected
  retry can reuse it. Full write-up in `server/docs/API.md` §3.
- **Double-booking is prevented by the database, not by a check.** Mongo has no
  range-exclusion constraint, so each booking is expanded into 5-minute grid
  slots and a **unique partial multikey index** on
  `{ tenantId, resourceId, slotKeys }` rejects overlaps. Cancelled bookings drop
  out of the index and release their slots. This is why start/end times must be
  5-minute aligned.
- **One set of Zod schemas.** `server/src/validation/booking.schemas.js` is
  imported by the browser through the `@shared` Vite alias, so the form and the
  API enforce literally the same rules.
- **Week 1 is untouched.** No Week 1 server file was modified. Request ids,
  rate limiting and the new error envelope are all mounted on the bookings
  router. On the client, `lib/api.js` is untouched and the booking UI uses its
  own transport (`lib/bookingClient.js`).

### Intentionally not done

- **No TypeScript and no `npm run typecheck`.** The repo is plain JavaScript
  and the instruction was to leave the existing setup alone, so the brief's
  "TS strict, no `any`" constraint is not met. New booking code carries JSDoc
  types instead. Migrating would mean rewriting every Week 1 file.
- **No ESLint / `npm run lint`.** No config exists anywhere in the repo; adding
  one would immediately flag Week 1 files. Ask and it can be added scoped to
  the booking files only.
- **No cursor pagination** — `page`/`limit` only, which is what the UI uses.
- **No `Resource` collection.** `resourceId` is a validated free-form string;
  there is no resource directory, availability calendar or per-resource
  opening hours.
- **Idempotency covers `POST` only.** `PATCH` is guarded by optimistic
  concurrency and `DELETE` is idempotent by construction, so neither needs a key.
- **Only successful responses are replayable.** A failed attempt releases its
  key rather than storing the error — a deliberate trade-off, documented in
  API.md §3.
- **No E2E browser test.** The calendar, filters and detail drawer are covered
  by manual verification plus the form's component tests, not Playwright.

## 12. Week 3 — payments, webhooks & pricing UI

Stripe subscription billing: a plan catalog, hosted Checkout, a signature-
verified webhook pipeline, and a pricing + billing-history UI that reflects
webhook-driven changes without a manual refresh.

Full reference: **[`server/docs/BILLING.md`](server/docs/BILLING.md)**.

### Billing is optional

Every Stripe variable in `server/.env.example` is optional. Leave them blank
and the app boots and runs exactly as before — `/api/billing/*` reads still
work, commands answer a clean `503 BILLING_NOT_CONFIGURED`, and the pricing
page renders read-only. Nothing from Week 1 or Week 2 changes either way.

### Turning billing on

**1. Secret key.** From [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys)
(confirm **Test mode** is on) into `server/.env`:

```
STRIPE_SECRET_KEY=sk_test_...
```

**2. Prices.** Rather than creating four prices by hand:

```bash
npm run stripe:setup
```

This creates the Pro and Business products with monthly + yearly prices,
reading the amounts from `config/plans.js` so Stripe cannot drift from the
catalog, and prints the four `STRIPE_PRICE_*` lines to paste into
`server/.env`. It is safe to re-run — products are looked up by
`metadata.planId` and a price is only created if no matching one exists — and
it refuses to run against a live key.

Restart the server. **Checkout now works**: open
`http://acme.lvh.me:5173/dashboard/plans` and pay with test card
`4242 4242 4242 4242` (any future expiry, any CVC). Use
`4000 0000 0000 0002` to watch a decline.

**3. Webhooks (optional for a first test).** Stripe cannot reach `localhost`,
so events need forwarding:

```bash
# install once: winget install Stripe.StripeCLI
stripe login
stripe listen --forward-to localhost:5000/api/webhooks/stripe
# paste the printed whsec_... into STRIPE_WEBHOOK_SECRET, restart the server
```

Leave `stripe listen` running in its own terminal.

**Without it the flow still completes.** The UI detects that no webhook
arrived and falls back to `POST /api/billing/sync` after 8 seconds, which pulls
the state straight from Stripe. You see "Payment received — activating your
plan…" for a few seconds longer, then the plan goes live. That fallback is
deliberate, not a workaround: it is the same path that repairs a webhook which
failed every delivery retry in production.

### What was added

| Area | Pieces |
| --- | --- |
| Catalog | `config/plans.js` — free / pro / business, monthly + yearly |
| Models | `Subscription`, `Invoice`, `WebhookEvent`; `Tenant` gains `stripeCustomerId` |
| Services | `stripe.js`, `billing.js` (commands), `billingSync.js` (Stripe → local), `webhookEvents.js` (dedupe) |
| Routes | `/api/billing/*` (tenant-scoped, role-guarded), `/api/webhooks/stripe` (public, signed) |
| Entitlements | `services/entitlements.js` + `middleware/enforcePlanLimits.js` — plan limits actually enforced |
| UI | `/dashboard/plans`, `/dashboard/billing`, usage meters, plan-change dialog with proration quote |

### Plan limits

| Plan | Bookings/mo | Team | Resources |
| --- | --- | --- | --- |
| `free` | 50 | 2 | 1 |
| `pro` | 2,000 | 15 | 25 |
| `business` | Unlimited | Unlimited | Unlimited |

Enforced on `POST /api/bookings` and on registering the 2nd+ user, returning
**402** (`PLAN_LIMIT_EXCEEDED`) — not 403, because the truthful message is
"upgrade and you may", and the UI shows an upsell rather than a dead end.

**Reads and edits are never blocked.** A tenant over its limit — usually one
that just downgraded — can still list, edit and cancel everything it has; only
*creating more* stops. That is what makes a downgrade always safe to apply, and
it is what `billing.limits.test.js` mostly exists to protect.

Limits are counted from what actually exists, never from a stored counter, so
there is nothing to drift, double-increment on a retry, or backfill.

> **Upgrade note.** Enabling enforcement means existing tenants — all of them
> on `free` — are now capped at 1 resource and 50 bookings/month. Move real
> workspaces onto a paid plan, or raise the free tier in
> `server/src/config/plans.js`, which is the single place those numbers live.

### Three decisions worth knowing

**The webhook is mounted before `express.json()`.** Stripe signs the exact bytes
it sent; once the JSON parser consumes the stream those bytes are gone, and any
re-serialisation fails verification. `app.js` therefore gives the webhook router
`express.raw()` first. This ordering is load-bearing.

**Duplicate and out-of-order events are both handled, separately.** Stripe
delivers at-least-once and in no guaranteed order. A unique-index ledger makes
the *effects* exactly-once; a `lastEventAt` guard inside each write's filter
makes a late-arriving older event a no-op rather than a plan regression.

**Reads never touch Stripe.** Webhooks maintain a local mirror, so the billing
page loads at database speed and stays readable when Stripe is slow or down.
`POST /api/billing/sync` is the explicit repair path when an event is missed.

### Test it

| Command | What it covers |
| --- | --- |
| `npm run test:server` | 120 tests — 54 from Week 2, plus 66 for billing & limits |
| `npm run test:client` | 24 tests — 7 from Week 2, plus 17 for pricing & limits |

`billing.webhook.test.js` uses **real** Stripe signature verification (local
crypto, no network, nothing mocked away) to cover forged signatures, wrong
secrets, tampered bodies, expired timestamps, duplicate delivery, out-of-order
events, unknown prices and cross-tenant isolation.
`billing.api.test.js` runs with **no Stripe keys at all** and pins that the
unconfigured path stays clean and Week 1's error shape is untouched.

### Intentionally not done

- **No historical usage.** Meters show the *current* month only; there is no
  chart of past consumption and no record kept once a month rolls over.
- **No grace period or soft limit.** Hitting a cap blocks the next create
  immediately. Real products usually allow a small overage with a warning
  first; that policy would live in `services/entitlements.js`.
- **No proactive "you're near your limit" email.** The warning is in the UI
  (from 80% onward) and nowhere else — this app sends no mail at all.
- **No tax, VAT or invoice localisation.** `automatic_tax` is off and prices are
  USD-only.
- **No trials.** The model mirrors `trial_end` and the UI renders it, but no
  plan is configured to start one.
- **No seats or metered pricing.** Every subscription is quantity 1.
- **No dunning emails.** A failed payment is surfaced in the UI; Stripe's own
  retry schedule handles the rest, and no mail is sent from this app.
- **Payment methods are managed in Stripe's Billing Portal**, not rebuilt here
  — deliberate, since it keeps card data off this server entirely (SAQ-A).
- **No E2E browser test** of the real Checkout redirect, for the same reason as
  Week 2: covered by component tests plus manual verification.

## 13. Troubleshooting

**`querySrv ECONNREFUSED _mongodb._tcp.<cluster>.mongodb.net` at startup or seed.**
A `mongodb+srv://` (Atlas) URI requires a DNS **SRV** lookup. On some setups —
notably Windows, where Node's c-ares resolver can latch onto an unreachable
IPv6 router as its DNS server — that lookup fails even though the OS resolver
(and `nslookup`) work fine. The app handles this automatically: `connectDb()`
prepends public resolvers (`8.8.8.8`, `1.1.1.1`) for `+srv` URIs
(see `server/src/config/db.js`). If you still hit it with a custom setup,
either set your adapter's DNS to `8.8.8.8`, or use Atlas's **non-SRV**
("standard") connection string from *Connect → Drivers → older driver version*,
which lists the shard hosts directly and skips the SRV lookup.

**`Ping request could not find host app.local`.** The hosts-file entries
(section 8) are not saved. On Windows the editor must run **as Administrator**
to write `C:\Windows\System32\drivers\etc\hosts`; then run `ipconfig /flushdns`.

**Signup redirects to a page that won't load.** You are browsing `localhost`
instead of `app.local`. The root/marketing page renders on `localhost`, but the
tenant flow requires the subdomain — start at `http://app.local:5173`.

---

### Security measures implemented

**Weeks 1–2.** helmet · CORS locked to the subdomain pattern (not `*`) ·
`express-rate-limit` on `/api/auth/*`, `/api/bookings/*` and `/api/billing/*` ·
bcrypt 12 rounds · JWTs in `httpOnly` cookies (not localStorage) · separate
access/refresh secrets · token `tenantId` cross-checked against the subdomain
on every request · zod validation on every DB-touching body · env validated at
boot · no secrets/URIs ever logged or returned in responses.

**Week 3 (payments).** Card data never touches this server — hosted Checkout
keeps the PCI surface at SAQ-A · webhook signatures verified over the **raw**
body before anything is parsed or logged · a signed payload older than the
tolerance window is rejected, bounding replay of a captured request · duplicate
events are made side-effect-free by a unique-index ledger · the client names a
**plan**, never a price or amount, so it cannot select a $0 price · plan
mutations require `owner`/`admin` · Stripe errors are translated so provider
internals and key hints never reach the browser · the webhook body is capped at
1 MB on an unauthenticated endpoint.

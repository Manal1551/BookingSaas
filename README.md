# Multi-Tenant SaaS Starter (MERN) — Week 1

## 1. Overview

A production-shaped starter for a multi-tenant SaaS built on the MERN stack
(MongoDB, Express, React, Node). Each customer ("tenant") gets its own
subdomain (`acme.app.local`), and every piece of tenant data is isolated at the
**document level** — enforced in the application layer, not left to convention.
Week 1 delivers tenancy, subdomain routing, JWT auth with per-tenant token
binding, a seeded database, and a responsive dashboard shell.

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

## 4. Folder structure

```
/
├── package.json              # workspaces + concurrently scripts
├── docker-compose.yml        # mongo + mongo-express (local dev)
├── README.md
├── server/
│   ├── .env.example
│   ├── src/
│   │   ├── config/           # env.js (zod validation), db.js
│   │   ├── models/           # Tenant.js, User.js
│   │   ├── middleware/       # resolveTenant, requireAuth, tenantScopePlugin, errorHandler
│   │   ├── routes/           # auth.routes.js, tenant.routes.js
│   │   ├── controllers/      # auth.controller.js, tenant.controller.js
│   │   ├── utils/            # tenantContext (AsyncLocalStorage), tokens, corsOrigin, httpError
│   │   ├── app.js            # express app wiring (helmet/cors/rate-limit)
│   │   └── server.js         # boot: connect DB + listen
│   └── scripts/
│       ├── seed.js            # 3 tenants, realistic users, idempotent
│       └── verify-isolation.js# proves cross-tenant access is rejected
└── client/
    ├── .env.example
    ├── vite.config.js        # host + allowedHosts wildcard
    └── src/
        ├── pages/            # Landing, Login, Register, Dashboard
        ├── components/       # Sidebar, ProtectedRoute, TenantContext
        ├── lib/              # api.js, useTenant.js
        ├── App.jsx           # root-domain vs tenant routing
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

# 5. (optional) Prove tenant isolation
npm run verify:isolation

# 6. Configure local subdomains — see section 8. Quickest: add to hosts file:
#     127.0.0.1  app.local acme.app.local globex.app.local initech.app.local

# 7. Run client + server together
npm run dev
```

Then visit:

- Root / signup:   `http://app.local:5173`
- Acme workspace:  `http://acme.app.local:5173`
- mongo-express:   `http://localhost:8081` (login `admin` / `admin`)

> If a required env var is missing or malformed, the server **exits immediately**
> with a message listing exactly which var is wrong (see `server/src/config/env.js`).

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

"tenant" = must be called on a tenant subdomain; "root" = called on the bare
root domain. Tokens travel in `httpOnly` cookies (a `Bearer` header is also
accepted for scripts).

## 10. Known limitations / next steps

Week 1 deliberately does **not** include:

- **No email verification** — accounts are usable immediately on register.
- **No refresh-token revocation store** — logout clears cookies, but a stolen
  refresh token remains valid until it expires. A denylist/rotation store is the
  next step.
- **No password reset / forgot-password flow.**
- **No billing / plan enforcement** — `plan` is stored but not enforced.
- **No rate limiting beyond `/api/auth/*`**, and no account lockout.
- **No automated test suite** — `verify-isolation.js` is a runnable proof, not a
  CI test harness (Jest/Vitest wiring is a follow-up).
- **Isolation is application-enforced** — strong only as long as every tenant
  model uses the plugin and no code bypasses it via `skipTenantScope`. A
  DB-per-tenant migration path is the escalation if a customer needs physical
  isolation.
- **Dashboard sub-pages** (bookings/team/settings) are navigation placeholders.

## 11. Troubleshooting

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

helmet · CORS locked to the subdomain pattern (not `*`) · `express-rate-limit`
on `/api/auth/*` · bcrypt 12 rounds · JWTs in `httpOnly` cookies (not
localStorage) · separate access/refresh secrets · zod validation on every
DB-touching body · env validated at boot · no secrets/URIs ever logged or
returned in responses.

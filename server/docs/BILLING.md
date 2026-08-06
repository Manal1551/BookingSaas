# Billing & Webhooks Reference (Week 3)

Subscription billing on Stripe: a plan catalog, hosted Checkout, a signed
webhook pipeline, and a local mirror of subscriptions and invoices.

`/api/billing/*` lives on the tenant **subdomain** and runs `resolveTenant` +
`requireAuth`, exactly like `/api/bookings/*`, and answers with the same error
envelope. `/api/webhooks/stripe` is the one exception in the whole app: it is
on the root domain, unauthenticated, and secured by signature verification
alone.

> **Scope note.** Week 1 routes (`/api/auth/*`, `/api/tenants/*`) keep their
> original `{ "error": "message" }` shape, and `/api/bookings/*` is unchanged.
> The billing router mounts its own error handler, reusing the Week 2 one.

---

## 1. Billing is optional

Every Stripe variable is optional. With none set:

- the app boots normally and all Week 1/2 functionality is unaffected;
- `GET /api/billing/plans` and `/subscription` still work, served from the
  local mirror, and report `billingEnabled: false`;
- commands that need Stripe answer `503 BILLING_NOT_CONFIGURED`;
- the pricing page renders the real catalog with checkout switched off.

This is what `server/tests/billing.api.test.js` runs against — the unconfigured
path is a supported state, not an accident.

---

## 2. Plan catalog

`server/src/config/plans.js` is the single source of truth for what a plan
*is*. Amounts live in code so the pricing page renders instantly and correctly
even when Stripe is slow; Stripe remains authoritative for what is actually
**charged**, which is why price IDs come from the environment.

| Plan | Monthly | Yearly | Bookings/mo | Team | Resources |
| --- | --- | --- | --- | --- | --- |
| `free` | $0 | $0 | 50 | 2 | 1 |
| `pro` | $29 | $290 | 2,000 | 15 | 25 |
| `business` | $99 | $990 | Unlimited | Unlimited | Unlimited |

`free` and `pro` are the two ids Week 1 already stored on `Tenant.plan` and
keep their exact meaning; `business` is added above them.

Amounts are integer **minor units** (2900 = $29.00) everywhere, matching
Stripe. Unlimited limits are `Infinity` in code and travel as `null` in JSON.

---

## 3. Endpoints

### Reads — any signed-in user

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/billing/plans` | Catalog, `currentPlanId`, `currentInterval`, per-interval `actions`, `billingEnabled` |
| `GET` | `/api/billing/subscription` | Current plan, subscription state, `syncedAt` |
| `GET` | `/api/billing/invoices` | Paginated history (`page`, `limit`, `status`) |
| `GET` | `/api/billing/usage` | Consumption vs. the plan's limits, per meter |

All four read from the local mirror — **zero Stripe calls**, so the billing
page loads at database speed and stays readable if Stripe is down.

### Commands — `owner` / `admin` only

| Method | Path | Does |
| --- | --- | --- |
| `POST` | `/api/billing/checkout` | Creates a Checkout Session, returns its URL |
| `POST` | `/api/billing/portal` | Creates a Billing Portal session |
| `GET` | `/api/billing/preview` | Quotes a plan switch (proration) |
| `POST` | `/api/billing/change` | Applies an upgrade/downgrade in place |
| `POST` | `/api/billing/cancel` | Schedules cancellation at period end |
| `POST` | `/api/billing/resume` | Undoes a scheduled cancellation |
| `POST` | `/api/billing/sync` | Pulls state from Stripe and re-applies it |

`checkout`, `change` and `preview` take `{ planId, interval }`.

**The client never names a price, an amount, or a customer.** It names a plan
and an interval; the server resolves those to a Stripe price from its own
catalog. A client that could name a price could name a $0 one.

`POST /checkout` accepts an optional `Idempotency-Key` (UUID), forwarded to
Stripe, so a double-submitted form reuses the same session rather than opening
a second one.

### Plan actions are per-interval

`/plans` returns `actions: { monthly, yearly }` per plan, not a single
`action`, because the button's meaning depends on the interval being viewed:

| From | Viewing | Action |
| --- | --- | --- |
| Pro monthly | Pro monthly | `current` |
| Pro monthly | Pro **yearly** | `switch_interval` |
| Pro monthly | Business | `upgrade` |
| Pro monthly | Free | `downgrade` (i.e. cancel) |

Collapsing this to "same plan id = current" disables the button and makes
**annual billing unreachable from the UI** — the one switch a business most
wants to offer. `currentInterval` is null unless a subscription is *entitled*,
so a cancelled subscription's old interval never looks current.

The plan-level `current` flag is kept separately for the "Your plan" badge,
which stays true whichever interval the visitor is browsing.

Free is not a purchasable price, so its `downgrade` action opens a
cancellation confirmation rather than a checkout or a proration quote.

### Error codes added in Week 3

| Code | HTTP | When |
| --- | --- | --- |
| `BILLING_NOT_CONFIGURED` | 503 | No Stripe keys on this deployment |
| `PLAN_UNAVAILABLE` | 409 | Plan exists in the catalog but has no price ID wired up |
| `NO_SUBSCRIPTION` | 404 | An operation needing a subscription found none |
| `PLAN_UNCHANGED` | 409 | Asked to switch to the plan already in effect |
| `STRIPE_ERROR` | 502 | Stripe refused or was unreachable |
| `PLAN_LIMIT_EXCEEDED` | 402 | Valid request, but the plan has no room left |

The Week 2 codes (`VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`,
`NOT_FOUND`, `RATE_LIMITED`, `INTERNAL_ERROR`) apply unchanged.

---

## 4. Limit enforcement

`Tenant.plan` is the only input to an entitlement check. It is **derived** by
the webhook pipeline from the subscription state, so a check is a plain
indexed field read — no Stripe call, no subscription join, nothing that can
time out on the request path. That is the entire reason the plan is
denormalised onto the tenant.

### The rule: writes are blocked, reads never are

| Action | Over the limit? |
| --- | --- |
| `POST /api/bookings` | **Blocked** — 402 `PLAN_LIMIT_EXCEEDED` |
| `POST /api/auth/register` (2nd user onward) | **Blocked** — 402, flat error shape |
| `GET /api/bookings` | Always allowed |
| `PATCH` / `DELETE /api/bookings/:id` | Always allowed |

Going over a limit — or downgrading while over one — must never hide data a
customer already has. Existing bookings stay listable, editable and
cancellable; only *creating more* stops. That is what makes a downgrade always
safe to apply, and it is pinned by tests in `billing.limits.test.js`.

### Where the checks live

`services/entitlements.js` holds the logic; `middleware/enforcePlanLimits.js`
mounts it on `POST /api/bookings` only.

Ordering matters: the check runs **after** validation and **before** the
controller, so a rejected request never reaches `withIdempotency` and therefore
never burns the caller's `Idempotency-Key` — they can upgrade and retry with
the same one. It also re-reads the tenant rather than using the copy
`resolveTenant` cached, so a webhook that upgraded the plan mid-request (the
common "upgrade in another tab, then retry" case) takes effect immediately.

### What each limit means

- **`bookingsPerMonth`** — bookings *created* in the current UTC calendar
  month, cancelled ones included. Create-then-cancel is still usage; not
  counting it would make the limit trivially bypassable.
- **`resources`** — distinct `resourceId` values ever booked. Only a **new**
  resource can push the count up, so a tenant at its limit can keep booking the
  resources it already uses.
- **`teamMembers`** — users in the tenant. The **first** user is always
  allowed whatever the plan: a workspace nobody can register into would be
  unreachable, and no plan should be able to produce that.

Limits are checked against **what exists**, never against a stored counter.
There is no usage column to drift, double-increment on a retry, or backfill.

### Why 402, not 403

402 Payment Required is the one status HTTP reserved for exactly this. 403
would say "you may never do this"; the truth is "upgrade and you may". Clients
branch on it to show an upsell rather than an access-denied dead end — the
booking form renders an amber panel with a *View plans* link, not a red
validation error.

The seat limit on `POST /api/auth/register` deliberately reports in Week 1's
flat `{ "error": "message" }` shape, because the existing Register page already
parses that contract.

---

## 5. Webhooks

`POST /api/webhooks/stripe`

### Why the raw body matters

Stripe signs the **exact bytes** it sent. `JSON.parse` followed by
`JSON.stringify` can reorder keys, change number formatting, and re-escape
unicode — the result no longer hashes to the signed digest, and every event
would be rejected as forged.

So `app.js` mounts the webhook router **before** the global `express.json()`,
and the router uses `express.raw({ type: 'application/json', limit: '1mb' })`.
This ordering is load-bearing; moving the mount below `express.json()` breaks
every webhook. `billing.api.test.js` pins that the JSON parser still works
everywhere else.

### The processing order

1. **Verify the signature** over the raw buffer. Nothing is parsed, logged, or
   acted on before this passes.
2. **Reject stale payloads.** `constructEvent`'s tolerance
   (`STRIPE_WEBHOOK_TOLERANCE_SECONDS`, default 300) bounds how old a signed
   payload may be, so a request captured off the wire cannot be resent later.
3. **Dedupe** against the `webhook_events` ledger.
4. **Handle**, then acknowledge.

### Duplicate delivery

Stripe guarantees *at-least-once* delivery: it retries on any non-2xx, on a
timeout, and occasionally re-sends an event even after a 200. `WebhookEvent`
makes the **effects** exactly-once, using the same transaction-free two-phase
protocol as Week 2's idempotency service — atomicity comes from a unique index
on `eventId`, not from a transaction (standalone Mongo has none).

| Ledger state on arrival | Response | Work done |
| --- | --- | --- |
| absent | `200 {received, handled}` | Handler runs |
| `processed` | `200 {duplicate: true}` | None |
| `processing` (< 60s) | `409` — Stripe retries | None |
| `processing` (> 60s) | claim taken over | Handler runs |
| `failed` | claim released | Handler re-runs |

### Out-of-order delivery

Stripe does **not** promise ordered delivery. A rapid upgrade-then-downgrade
can arrive reversed, which would otherwise leave a tenant permanently on the
wrong plan.

Every write is conditional on `lastEventAt <= incoming event time`, and the
check lives in the *filter* so check-and-write is one atomic operation:

```js
Subscription.updateOne(
  { stripeSubscriptionId: id,
    $or: [{ lastEventAt: null }, { lastEventAt: { $lte: eventAt } }] },
  { $set: fields },
  { upsert: true }
);
```

If a newer event already landed, the filter misses, the upsert attempts an
insert, and the unique index rejects it — an `E11000` here *is* the signal that
the event is stale. It is caught and the event acknowledged.

### Response contract

A 2xx tells Stripe "delivered, stop retrying". So:

- **2xx** for anything a retry could never fix — unhandled event type, unknown
  tenant, a price outside the catalog, a stale event. Returning 500 for these
  would burn three days of retries for nothing.
- **5xx** only for genuinely transient failures we want redelivered.
- **400** for a failed signature check (and the event is never recorded).

### Handled events

| Event | Effect |
| --- | --- |
| `checkout.session.completed` | Activates the plan (see below) |
| `checkout.session.async_payment_succeeded` | Same |
| `checkout.session.expired` | Noted only |
| `checkout.session.async_payment_failed` | Noted only — nothing was ever activated |
| `customer.subscription.created` / `.updated` | Mirrors the subscription, re-derives `Tenant.plan` |
| `customer.subscription.paused` / `.resumed` / `.trial_will_end` | Same |
| `customer.subscription.deleted` | Marks canceled, drops the tenant to Free |
| `invoice.created` / `.finalized` / `.paid` / `.payment_succeeded` | Mirrors the invoice |
| `invoice.payment_failed` | Mirrors it and re-derives the plan |
| `invoice.voided` / `.marked_uncollectible` | Mirrors it |

Anything else is acknowledged with `handled: false` and recorded, so an
unexpected type is discoverable rather than silently dropped.

On `checkout.session.completed`: the session's `subscription` is used directly
when it arrives as an expanded object, and fetched from Stripe when it is a
bare id. Stripe sends a bare id by default, so the fetch is the usual path —
the session snapshot predates any immediate invoice settling, and only a fresh
read has the real status. Handling both shapes also means the full activation
path is testable without a network call, which is why the most important event
in the flow now has coverage.

A session whose payment is still clearing (`payment_status: 'unpaid'`) is
deferred, not activated: the `customer.subscription.*` events carry the real
state once it settles.

### Tenant resolution

A webhook has no subdomain and no session, so the tenant is resolved from the
Stripe object, in this order:

1. `Tenant.stripeCustomerId` — the mapping *we* created; cannot be edited from
   the Stripe dashboard.
2. `metadata.tenantId` — stamped on every customer, subscription and checkout
   session; covers the window before the link is saved.
3. One `customers.retrieve` call, as a last resort.

Unresolvable objects (e.g. a customer created by hand in the dashboard) are
acknowledged with `ignored:unknown-tenant`.

**Tenant isolation is preserved, not bypassed.** `Subscription` and `Invoice`
carry the same scope plugin as every other tenant model. Since there is no
request context, the webhook re-enters one explicitly with `runWithTenant`
before writing.

> **Gotcha, learned the hard way.** A Mongoose query is *lazy*. Returning an
> un-awaited Query from `runWithTenant` lets it execute after the async context
> has exited, and the plugin (correctly) refuses to run without a tenant. Every
> tenant-scoped query in `billingSync.js` **awaits inside** its callback.

---

## 6. Data model

| Collection | Scoped? | Written by | Purpose |
| --- | --- | --- | --- |
| `subscriptions` | yes | webhooks only | Local mirror of Stripe subscriptions |
| `invoices` | yes | webhooks only | Billing history |
| `webhook_events` | **no** | webhook pipeline | Dedupe ledger, 30-day TTL |

`webhook_events` is deliberately unscoped: a webhook arrives with no tenant in
context, dedupe must happen *before* resolution, and Stripe event ids are
globally unique anyway.

`Tenant` gains `stripeCustomerId` and an extended `plan` enum.

> **Index note.** `stripeCustomerId` uses a **partial** unique index
> (`$type: 'string'`), not a sparse one. `sparse` skips only *missing* fields,
> so any explicit `null` would make every unbilled tenant collide — the second
> signup would fail. This is a real bug that `billing.api.test.js` caught.

`Tenant.plan` is **derived**, never asserted by a client: it is recomputed from
all of a tenant's subscription rows, so cancelling one of two active
subscriptions does not strip access, and the answer is the same regardless of
which event triggered the recompute.

Run `npm run sync:indexes` after pulling Week 3 to build the new indexes.

---

## 7. Proration

| Direction | `proration_behavior` | Effect |
| --- | --- | --- |
| Upgrade | `always_invoice` | Bigger plan now, prorated difference charged immediately |
| Downgrade | `create_prorations` | Keeps the paid-for period, credit offsets the next invoice |

Downgrades deliberately avoid refunds for a plan still in use. `GET /preview`
quotes Stripe's own arithmetic rather than estimating, so the confirmation
dialog matches the invoice.

Cancellation is never immediate: `cancel_at_period_end` flips,
`Tenant.plan` stays put, and the drop to Free happens when
`customer.subscription.deleted` arrives at period end.

---

## 8. Local development

Stripe cannot reach `localhost`, so use the CLI to forward events:

```bash
stripe login
stripe listen --forward-to localhost:5000/api/webhooks/stripe
# paste the printed whsec_... into STRIPE_WEBHOOK_SECRET, restart the server
```

Trigger events without paying:

```bash
stripe trigger customer.subscription.created
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
```

Test card: `4242 4242 4242 4242`, any future expiry, any CVC.
Declines on purpose: `4000 0000 0000 0002`.

**Without the CLI running**, checkout still completes on Stripe and the browser
returns — the UI then falls back to `POST /api/billing/sync` after 8 seconds,
which pulls the state directly. That fallback is why the flow is usable with no
tunnel at all.

---

## 9. Frontend reconciliation

Checkout completes on **Stripe's** servers, so the browser returns to a UI
whose local state is still the old plan; the real update arrives moments later,
out of band, as a webhook. Rather than showing a stale plan — or lying and
showing the new one before it is real — `useCheckoutReconciliation` makes the
gap explicit:

| Elapsed | Behaviour |
| --- | --- |
| 0–8s | Poll `/subscription`; the webhook normally lands in 1–2s |
| 8s | Call `/sync` once — covers local dev with no tunnel, and failed deliveries |
| 45s | Stop and offer a manual "Refresh billing status" |

The pending plan is parked in `sessionStorage` before the redirect (React state
cannot survive a full-page navigation) so the UI waits for *the plan that was
bought*, not merely "any change" — otherwise an existing subscriber would see
"done" against their old plan.

On success it calls `hydrate()` to refresh the auth session, because the
dashboard header renders `tenant.plan` and would otherwise keep claiming the
old one until a full reload.

---

## 10. Tests

```bash
npm run test:server    # 120 tests
npm run test:client    # 24 tests
```

`billing.webhook.test.js` (26 tests) runs against real MongoDB and **real
Stripe signature verification** — no Stripe network calls and none mocked away,
because signing is local crypto. It covers forged signatures, wrong secrets,
tampered bodies, expired timestamps, duplicate delivery, out-of-order events,
unknown prices, unknown tenants, and cross-tenant isolation.

`billing.api.test.js` (22 tests) runs with **no Stripe keys configured** and
pins that reads still work, commands 503 cleanly, roles are enforced, invoices
never cross tenants, and Week 1's flat error shape is untouched.

`billing.limits.test.js` (18 tests) covers enforcement: blocking at the limit,
unblocking the instant a plan changes, never burning an `Idempotency-Key` on a
rejection, the first user always being allowed — and, most importantly, that
listing, editing and cancelling all keep working while over a limit.

On the client, `PlanLimits.test.jsx` pins that a limit renders as an upsell
with a working link, that an overage reports its true count rather than a
clamped one, and that a retry after upgrading reuses the same idempotency key.

> **Fixture note.** `bookings.integration.test.js` now creates its tenant on
> the `business` plan. Those tests are about booking *semantics* (idempotency,
> overlap, optimistic concurrency); on the default `free` plan its
> multi-resource scenarios would fail against the 1-resource cap for a reason
> they are not testing. Enforcement has its own suite.

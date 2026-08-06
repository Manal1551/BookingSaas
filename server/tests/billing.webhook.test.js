import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * End-to-end tests for the Stripe webhook pipeline, against a real MongoDB
 * (in-memory) and real Stripe signature verification.
 *
 * No Stripe network calls are made and none are mocked away: signature
 * generation and verification are local crypto, and every event used here
 * resolves its tenant from data we already hold. That keeps the tests honest
 * about the parts that actually carry risk — the signature check, the dedupe
 * ledger, the ordering guard, and tenant isolation — rather than testing a
 * stub of Stripe.
 *
 * As in the Week 2 suite, `config/env.js` freezes the environment on import,
 * so every var is set before any application module is pulled in.
 */

let mongoose;
let mongod;
let app;
let request;
let stripe;
let Tenant;
let Subscription;
let Invoice;
let WebhookEvent;

let acme;
let globex;

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_verification_only';
const PRICE_PRO_MONTHLY = 'price_test_pro_monthly';
const PRICE_PRO_YEARLY = 'price_test_pro_yearly';
const PRICE_BUSINESS_MONTHLY = 'price_test_business_monthly';

const WEBHOOK_PATH = '/api/webhooks/stripe';

/** Seconds, as Stripe sends them. */
const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Builds a Stripe-shaped event envelope. */
function makeEvent(type, object, { id = `evt_${randomUUID()}`, created = nowSeconds() } = {}) {
  return {
    id,
    object: 'event',
    api_version: '2025-10-29.clover',
    created,
    type,
    livemode: false,
    data: { object },
  };
}

/** A Stripe Subscription object, minimal but shaped like the real thing. */
function subscriptionObject({
  id = `sub_${randomUUID().slice(0, 8)}`,
  customer,
  price = PRICE_PRO_MONTHLY,
  status = 'active',
  cancelAtPeriodEnd = false,
  metadata = {},
} = {}) {
  const start = nowSeconds();
  return {
    id,
    object: 'subscription',
    customer,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    canceled_at: null,
    trial_end: null,
    metadata,
    items: {
      object: 'list',
      data: [
        {
          id: `si_${randomUUID().slice(0, 8)}`,
          price: { id: price, object: 'price' },
          current_period_start: start,
          current_period_end: start + 30 * 24 * 3600,
        },
      ],
    },
  };
}

function invoiceObject({
  id = `in_${randomUUID().slice(0, 8)}`,
  customer,
  subscription = null,
  status = 'paid',
  amount = 2900,
} = {}) {
  const created = nowSeconds();
  return {
    id,
    object: 'invoice',
    customer,
    number: 'ACME-0001',
    status,
    amount_due: amount,
    amount_paid: status === 'paid' ? amount : 0,
    amount_remaining: status === 'paid' ? 0 : amount,
    currency: 'usd',
    created,
    period_start: created,
    period_end: created + 30 * 24 * 3600,
    status_transitions: { finalized_at: created, paid_at: status === 'paid' ? created : null },
    hosted_invoice_url: 'https://invoice.stripe.com/test',
    invoice_pdf: 'https://invoice.stripe.com/test.pdf',
    parent: subscription
      ? { subscription_details: { subscription } }
      : null,
    lines: {
      object: 'list',
      data: [
        {
          description: 'Pro plan',
          amount,
          pricing: { price_details: { price: PRICE_PRO_MONTHLY } },
        },
      ],
    },
  };
}

/**
 * POSTs an event with a genuine Stripe signature over the exact bytes sent.
 *
 * `.set('Content-Type', 'application/json').send(payload_string)` matters:
 * supertest must transmit the string verbatim so the bytes the server hashes
 * are the bytes we signed. Passing an object would let supertest re-serialise
 * it and the signature would no longer match.
 */
function postEvent(event, { secret = WEBHOOK_SECRET, timestamp, signature } = {}) {
  const payload = JSON.stringify(event);
  const header =
    signature ??
    stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: timestamp ?? nowSeconds(),
    });

  return request(app)
    .post(WEBHOOK_PATH)
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', header)
    .send(payload);
}

/** Reads tenant-scoped rows without a request context, for assertions only. */
const scoped = (Model, tenant, filter = {}) =>
  Model.find({ ...filter, tenantId: tenant._id }).setOptions({ skipTenantScope: true }).lean();

/**
 * A tenant of its own, for tests that assert on the DERIVED `Tenant.plan`.
 *
 * That value is recomputed from *all* of a tenant's subscriptions, so a test
 * sharing a tenant with earlier ones would be reading their leftovers — a
 * cancellation looks like a no-op if some other still-active subscription is
 * lying around. Tests that only assert on a specific subscription row can
 * safely share.
 */
let tenantCounter = 0;
async function freshTenant() {
  const n = tenantCounter++;
  return Tenant.create({
    name: `Isolated ${n}`,
    slug: `isolated-${n}`,
    stripeCustomerId: `cus_isolated_${n}`,
  });
}

before(async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri('billing_test');
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-11111';
  process.env.ROOT_DOMAIN = 'app.local';
  process.env.CLIENT_ORIGIN_PATTERN = 'http://*.app.local:5173';

  // A syntactically valid test key. Nothing in this suite calls the Stripe
  // API — signature verification is local HMAC — so it is never used to
  // authenticate anything.
  process.env.STRIPE_SECRET_KEY = 'sk_test_00000000000000000000000000';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRICE_PRO_MONTHLY = PRICE_PRO_MONTHLY;
  process.env.STRIPE_PRICE_PRO_YEARLY = PRICE_PRO_YEARLY;
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = PRICE_BUSINESS_MONTHLY;

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI);

  request = (await import('supertest')).default;
  app = (await import('../src/app.js')).createApp();
  stripe = (await import('../src/services/stripe.js')).getStripe();

  ({ Tenant } = await import('../src/models/Tenant.js'));
  ({ Subscription } = await import('../src/models/Subscription.js'));
  ({ Invoice } = await import('../src/models/Invoice.js'));
  ({ WebhookEvent } = await import('../src/models/WebhookEvent.js'));

  // The unique indexes are what make dedupe and the ordering guard atomic —
  // they must exist before the tests that rely on losing an insert.
  await Subscription.init();
  await Invoice.init();
  await WebhookEvent.init();

  acme = await Tenant.create({
    name: 'Acme',
    slug: 'acme',
    stripeCustomerId: 'cus_acme_test',
  });
  globex = await Tenant.create({
    name: 'Globex',
    slug: 'globex',
    stripeCustomerId: 'cus_globex_test',
  });
});

after(async () => {
  await mongoose?.disconnect();
  await mongod?.stop();
});

// --- Signature verification -------------------------------------------------

describe('webhook signature verification', () => {
  it('rejects a request with no Stripe-Signature header', async () => {
    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(makeEvent('customer.subscription.created', {})));

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing Stripe-Signature/i);
  });

  it('rejects a forged signature', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      subscriptionObject({ customer: 'cus_acme_test' })
    );
    const res = await postEvent(event, {
      signature: `t=${nowSeconds()},v1=deadbeefdeadbeefdeadbeefdeadbeef`,
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Signature verification failed/i);
  });

  it('rejects a signature made with the wrong secret', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      subscriptionObject({ customer: 'cus_acme_test' })
    );
    const res = await postEvent(event, { secret: 'whsec_a_completely_different_secret' });

    assert.equal(res.status, 400);
  });

  it('rejects a tampered body whose signature was valid for the original', async () => {
    const original = makeEvent(
      'customer.subscription.created',
      subscriptionObject({ customer: 'cus_acme_test' })
    );
    const payload = JSON.stringify(original);
    const header = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });

    // Same signature, one byte of the body changed — this is the attack the
    // raw-body requirement exists to defeat.
    const tampered = payload.replace('"livemode":false', '"livemode":true');

    const res = await request(app)
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', header)
      .send(tampered);

    assert.equal(res.status, 400);
  });

  it('rejects a replayed payload older than the tolerance window', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      subscriptionObject({ customer: 'cus_acme_test' })
    );
    // Correctly signed, but signed an hour ago — a captured-and-resent request.
    const res = await postEvent(event, { timestamp: nowSeconds() - 3600 });

    assert.equal(res.status, 400);
    const stored = await WebhookEvent.findOne({ eventId: event.id }).lean();
    assert.equal(stored, null, 'a rejected event is never recorded');
  });

  it('accepts a correctly signed, current payload', async () => {
    const event = makeEvent(
      'customer.subscription.created',
      subscriptionObject({ customer: 'cus_acme_test' })
    );
    const res = await postEvent(event);

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);
  });
});

// --- Duplicate delivery -----------------------------------------------------

describe('duplicate webhook delivery', () => {
  it('processes an event once and acknowledges every redelivery', async () => {
    const subscription = subscriptionObject({ customer: 'cus_acme_test' });
    const event = makeEvent('customer.subscription.created', subscription);

    const first = await postEvent(event);
    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, undefined);
    assert.equal(first.body.handled, true);

    // Stripe redelivers the identical event — twice, for good measure.
    const second = await postEvent(event);
    const third = await postEvent(event);

    assert.equal(second.status, 200, 'a duplicate is acknowledged, not retried');
    assert.equal(second.body.duplicate, true);
    assert.equal(third.body.duplicate, true);

    const rows = await scoped(Subscription, acme, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 1, 'three deliveries, exactly one subscription row');

    const ledger = await WebhookEvent.find({ eventId: event.id }).lean();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].state, 'processed');
  });

  it('treats two events with different ids as two events', async () => {
    const subscription = subscriptionObject({ customer: 'cus_acme_test' });

    await postEvent(makeEvent('customer.subscription.created', subscription));
    const res = await postEvent(
      makeEvent('customer.subscription.updated', subscription, {
        created: nowSeconds() + 1,
      })
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.duplicate, undefined);
    // Still one row: same subscription, updated in place rather than duplicated.
    const rows = await scoped(Subscription, acme, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 1);
  });
});

// --- Ordering ---------------------------------------------------------------

describe('out-of-order delivery', () => {
  it('ignores an older event that arrives after a newer one', async () => {
    const id = `sub_ordering_${randomUUID().slice(0, 6)}`;
    const base = nowSeconds();

    // The user upgraded to Business, and the event for it arrives first.
    const newer = makeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id, customer: 'cus_acme_test', price: PRICE_BUSINESS_MONTHLY }),
      { created: base + 60 }
    );
    // The earlier Pro event is delayed and lands afterwards.
    const older = makeEvent(
      'customer.subscription.updated',
      subscriptionObject({ id, customer: 'cus_acme_test', price: PRICE_PRO_MONTHLY }),
      { created: base }
    );

    assert.equal((await postEvent(newer)).status, 200);
    assert.equal((await postEvent(older)).status, 200, 'the straggler is still acked');

    const [row] = await scoped(Subscription, acme, { stripeSubscriptionId: id });
    assert.equal(row.planId, 'business', 'the newer event wins regardless of arrival order');

    const ledger = await WebhookEvent.findOne({ eventId: older.id }).lean();
    assert.equal(ledger.state, 'processed');
    assert.match(ledger.result, /skipped:stale-event/);
  });
});

// --- State changes ----------------------------------------------------------

describe('subscription lifecycle', () => {
  it('activates the plan on the tenant when a subscription starts', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({
      customer: owner.stripeCustomerId,
      price: PRICE_PRO_MONTHLY,
    });

    await postEvent(makeEvent('customer.subscription.created', subscription));

    const [row] = await scoped(Subscription, owner, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(row.planId, 'pro');
    assert.equal(row.interval, 'monthly');
    assert.equal(row.status, 'active');
    assert.ok(row.currentPeriodEnd instanceof Date);

    const tenant = await Tenant.findById(owner._id).lean();
    assert.equal(tenant.plan, 'pro', 'entitlement is derived, not asserted by the client');
  });

  it('drops the tenant back to free when the subscription is deleted', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({ customer: owner.stripeCustomerId });

    await postEvent(makeEvent('customer.subscription.created', subscription));
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'pro');

    await postEvent(
      makeEvent(
        'customer.subscription.deleted',
        { ...subscription, status: 'canceled' },
        { created: nowSeconds() + 120 }
      )
    );

    const [row] = await scoped(Subscription, owner, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(row.status, 'canceled');

    const tenant = await Tenant.findById(owner._id).lean();
    assert.equal(tenant.plan, 'free', 'losing the subscription loses the entitlement');
  });

  it('keeps a tenant entitled while any other subscription is still active', async () => {
    const owner = await freshTenant();
    const keep = subscriptionObject({ customer: owner.stripeCustomerId });
    const drop = subscriptionObject({ customer: owner.stripeCustomerId });

    await postEvent(makeEvent('customer.subscription.created', keep));
    await postEvent(makeEvent('customer.subscription.created', drop));

    await postEvent(
      makeEvent(
        'customer.subscription.deleted',
        { ...drop, status: 'canceled' },
        { created: nowSeconds() + 120 }
      )
    );

    // The plan is DERIVED from every subscription, not from the last event —
    // so cancelling one of two does not strip access.
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'pro');
  });

  it('does not entitle a tenant for a price outside the catalog', async () => {
    const subscription = subscriptionObject({
      customer: 'cus_acme_test',
      price: 'price_something_we_do_not_sell',
    });

    const res = await postEvent(makeEvent('customer.subscription.created', subscription));

    assert.equal(res.status, 200, 'acked — a retry could never fix an unknown price');
    const rows = await scoped(Subscription, acme, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 0, 'better no row than a guessed plan');
  });

  it('acknowledges an event for a customer belonging to no tenant', async () => {
    const res = await postEvent(
      makeEvent(
        'customer.subscription.created',
        subscriptionObject({ customer: 'cus_nobody_knows_this_one' })
      )
    );

    // 200, not 500: Stripe must stop retrying something we can never resolve.
    assert.equal(res.status, 200);
  });

  it('resolves the tenant from metadata when the customer link is unknown', async () => {
    const subscription = subscriptionObject({
      customer: 'cus_not_linked_yet',
      metadata: { tenantId: String(globex._id) },
    });

    await postEvent(makeEvent('customer.subscription.created', subscription));

    const rows = await scoped(Subscription, globex, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 1, 'metadata covers the window before the link is saved');
  });
});

// --- Checkout completion ----------------------------------------------------

/**
 * A Checkout Session carrying its subscription as an EXPANDED object.
 *
 * Stripe normally sends a bare id and the handler fetches the subscription
 * fresh — that call is what these tests would otherwise have to reach the
 * network for. Since the handler now uses an expanded object when one is
 * present, the full activation path is exercisable offline, which is the only
 * reason the most important event in the whole flow was previously untested.
 */
function checkoutSession({
  customer,
  subscription = null,
  status = 'complete',
  paymentStatus = 'paid',
  mode = 'subscription',
  metadata = {},
} = {}) {
  return {
    id: `cs_${randomUUID().slice(0, 8)}`,
    object: 'checkout.session',
    mode,
    status,
    payment_status: paymentStatus,
    customer,
    subscription,
    metadata,
  };
}

describe('checkout.session.completed', () => {
  it('activates the plan the customer just paid for', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({
      customer: owner.stripeCustomerId,
      price: PRICE_BUSINESS_MONTHLY,
    });

    const res = await postEvent(
      makeEvent(
        'checkout.session.completed',
        checkoutSession({ customer: owner.stripeCustomerId, subscription })
      )
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.handled, true);

    const [row] = await scoped(Subscription, owner, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(row.planId, 'business');
    assert.equal(row.status, 'active');
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'business');
  });

  it('is idempotent across a redelivery', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({ customer: owner.stripeCustomerId });
    const event = makeEvent(
      'checkout.session.completed',
      checkoutSession({ customer: owner.stripeCustomerId, subscription })
    );

    await postEvent(event);
    const again = await postEvent(event);

    assert.equal(again.body.duplicate, true);
    const rows = await scoped(Subscription, owner, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 1, 'paid once, subscribed once');
  });

  it('resolves the tenant from session metadata alone', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({ customer: 'cus_unlinked_checkout' });

    await postEvent(
      makeEvent(
        'checkout.session.completed',
        checkoutSession({
          customer: 'cus_unlinked_checkout',
          subscription,
          // What `subscription_data.metadata` stamps at checkout creation —
          // the bridge for a customer whose local link is not saved yet.
          metadata: { tenantId: String(owner._id) },
        })
      )
    );

    const rows = await scoped(Subscription, owner, {
      stripeSubscriptionId: subscription.id,
    });
    assert.equal(rows.length, 1);
  });

  it('ignores a one-off payment checkout', async () => {
    const owner = await freshTenant();

    const res = await postEvent(
      makeEvent(
        'checkout.session.completed',
        checkoutSession({ customer: owner.stripeCustomerId, mode: 'payment' })
      )
    );

    assert.equal(res.status, 200);
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'free');
  });

  it('defers while a delayed payment is still clearing', async () => {
    const owner = await freshTenant();
    const subscription = subscriptionObject({ customer: owner.stripeCustomerId });

    const res = await postEvent(
      makeEvent(
        'checkout.session.completed',
        checkoutSession({
          customer: owner.stripeCustomerId,
          subscription,
          status: 'open',
          paymentStatus: 'unpaid',
        })
      )
    );

    assert.equal(res.status, 200);
    // Not paid yet, so nothing is entitled — the subscription.* events carry
    // the real state once it settles.
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'free');
  });

  it('records an abandoned and a failed checkout without entitling anyone', async () => {
    const owner = await freshTenant();

    const expired = await postEvent(
      makeEvent(
        'checkout.session.expired',
        checkoutSession({ customer: owner.stripeCustomerId, status: 'expired' })
      )
    );
    const failed = await postEvent(
      makeEvent(
        'checkout.session.async_payment_failed',
        checkoutSession({
          customer: owner.stripeCustomerId,
          paymentStatus: 'unpaid',
        })
      )
    );

    assert.equal(expired.status, 200);
    assert.equal(failed.status, 200);
    assert.equal(failed.body.handled, true, 'a failed async payment is handled, not ignored');
    assert.equal((await Tenant.findById(owner._id).lean()).plan, 'free');
  });
});

// --- Invoices ---------------------------------------------------------------

describe('invoice events', () => {
  it('files a paid invoice against the right tenant', async () => {
    const invoice = invoiceObject({ customer: 'cus_acme_test', status: 'paid' });

    const res = await postEvent(makeEvent('invoice.paid', invoice));
    assert.equal(res.status, 200);

    const [row] = await scoped(Invoice, acme, { stripeInvoiceId: invoice.id });
    assert.equal(row.status, 'paid');
    assert.equal(row.amountPaid, 2900);
    assert.equal(row.planId, 'pro');
    assert.equal(row.invoicePdfUrl, 'https://invoice.stripe.com/test.pdf');
  });

  it('records a failed payment without duplicating the invoice', async () => {
    const id = `in_fail_${randomUUID().slice(0, 6)}`;
    const base = nowSeconds();

    await postEvent(
      makeEvent('invoice.created', invoiceObject({ id, customer: 'cus_acme_test', status: 'open' }), {
        created: base,
      })
    );
    await postEvent(
      makeEvent(
        'invoice.payment_failed',
        invoiceObject({ id, customer: 'cus_acme_test', status: 'open' }),
        { created: base + 30 }
      )
    );

    const rows = await scoped(Invoice, acme, { stripeInvoiceId: id });
    assert.equal(rows.length, 1, 'the same invoice is updated, never re-filed');
    assert.equal(rows[0].status, 'open');
  });
});

// --- Tenant isolation -------------------------------------------------------

describe('tenant isolation across webhooks', () => {
  it('never writes one tenant\'s billing state onto another', async () => {
    const acmeSub = subscriptionObject({ customer: 'cus_acme_test' });
    const globexSub = subscriptionObject({
      customer: 'cus_globex_test',
      price: PRICE_BUSINESS_MONTHLY,
    });

    await postEvent(makeEvent('customer.subscription.created', acmeSub));
    await postEvent(makeEvent('customer.subscription.created', globexSub));

    const acmeRows = await scoped(Subscription, acme, {
      stripeSubscriptionId: globexSub.id,
    });
    assert.equal(acmeRows.length, 0, "Globex's subscription is invisible to Acme");

    const [globexRow] = await scoped(Subscription, globex, {
      stripeSubscriptionId: globexSub.id,
    });
    assert.equal(globexRow.planId, 'business');
    assert.equal(String(globexRow.tenantId), String(globex._id));

    assert.equal((await Tenant.findById(globex._id).lean()).plan, 'business');
  });
});

// --- Endpoint hardening -----------------------------------------------------

describe('webhook endpoint hardening', () => {
  it('acknowledges an event type it does not handle', async () => {
    const event = makeEvent('customer.discount.created', { id: 'di_test' });
    const res = await postEvent(event);

    assert.equal(res.status, 200);
    assert.equal(res.body.handled, false);

    // Recorded all the same, so an unexpected event type is discoverable
    // rather than silently vanishing.
    const ledger = await WebhookEvent.findOne({ eventId: event.id }).lean();
    assert.equal(ledger.state, 'processed');
    assert.equal(ledger.result, 'ignored:unhandled-type');
  });

  it('never requires authentication (it is server-to-server)', async () => {
    // No cookie, no bearer token, no tenant subdomain — and it still works.
    const res = await postEvent(
      makeEvent(
        'customer.subscription.updated',
        subscriptionObject({ customer: 'cus_acme_test' })
      )
    );
    assert.equal(res.status, 200);
  });
});

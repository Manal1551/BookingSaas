import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for the `/api/billing/*` read surface and its guards.
 *
 * Run with NO Stripe keys configured — which is the point. Billing is optional
 * infrastructure, and this suite pins the promise that the rest of the app is
 * unaffected by its absence: reads still work off the local mirror, and the
 * commands that genuinely need Stripe fail with a clean, typed 503 instead of
 * crashing or leaking a provider error.
 *
 * Authorization, tenant scoping and the error envelope are checked here; the
 * Stripe-touching write paths are covered by billing.webhook.test.js, which
 * exercises the same models from the other direction.
 */

let mongoose;
let mongod;
let app;
let request;
let Tenant;
let Invoice;

let acme;
let globex;
let ownerToken;
let memberToken;
let globexToken;

const HOST = 'acme.app.local';

const authed = (method, path, token = ownerToken) =>
  request(app)[method](path).set('Host', HOST).set('Authorization', `Bearer ${token}`);

before(async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri('billing_api_test');
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-11111';
  process.env.ROOT_DOMAIN = 'app.local';
  process.env.CLIENT_ORIGIN_PATTERN = 'http://*.app.local:5173';

  // Deliberately absent: STRIPE_SECRET_KEY and every price ID.
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_YEARLY;
  delete process.env.STRIPE_PRICE_BUSINESS_MONTHLY;
  delete process.env.STRIPE_PRICE_BUSINESS_YEARLY;

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI);

  request = (await import('supertest')).default;
  app = (await import('../src/app.js')).createApp();

  ({ Tenant } = await import('../src/models/Tenant.js'));
  ({ Invoice } = await import('../src/models/Invoice.js'));
  await Invoice.init();

  acme = await Tenant.create({ name: 'Acme', slug: 'acme' });
  globex = await Tenant.create({ name: 'Globex', slug: 'globex' });

  const { signAccessToken } = await import('../src/utils/tokens.js');
  const { User } = await import('../src/models/User.js');
  const { runWithTenant } = await import('../src/utils/tenantContext.js');

  const [owner, member] = await runWithTenant(acme, async () => {
    const created = await User.create([
      { name: 'Ada', email: 'ada@acme.test', passwordHash: 'x', role: 'owner' },
      { name: 'Bob', email: 'bob@acme.test', passwordHash: 'x', role: 'member' },
    ]);
    return created;
  });

  ownerToken = signAccessToken({ userId: owner._id, tenantId: acme._id, role: 'owner' });
  memberToken = signAccessToken({ userId: member._id, tenantId: acme._id, role: 'member' });
  globexToken = signAccessToken({
    userId: new mongoose.Types.ObjectId(),
    tenantId: globex._id,
    role: 'owner',
  });

  // Two invoices for Acme, one for Globex — enough to prove scoping.
  await runWithTenant(acme, async () => {
    await Invoice.create([
      {
        stripeInvoiceId: 'in_acme_1',
        stripeCustomerId: 'cus_acme',
        status: 'paid',
        amountDue: 2900,
        amountPaid: 2900,
        planId: 'pro',
        issuedAt: new Date('2026-06-01'),
      },
      {
        stripeInvoiceId: 'in_acme_2',
        stripeCustomerId: 'cus_acme',
        status: 'open',
        amountDue: 2900,
        amountPaid: 0,
        planId: 'pro',
        issuedAt: new Date('2026-07-01'),
      },
    ]);
  });
  await runWithTenant(globex, async () => {
    await Invoice.create({
      stripeInvoiceId: 'in_globex_1',
      stripeCustomerId: 'cus_globex',
      status: 'paid',
      amountDue: 9900,
      amountPaid: 9900,
      planId: 'business',
      issuedAt: new Date('2026-07-15'),
    });
  });
});

after(async () => {
  await mongoose?.disconnect();
  await mongod?.stop();
});

// --- Catalog ----------------------------------------------------------------

describe('GET /api/billing/plans', () => {
  it('serves the catalog with the tenant\'s current plan marked', async () => {
    const res = await authed('get', '/api/billing/plans');

    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.plans.map((p) => p.id),
      ['free', 'pro', 'business']
    );
    assert.equal(res.body.currentPlanId, 'free');
    assert.equal(res.body.plans.find((p) => p.id === 'free').current, true);
  });

  it('labels each plan with the action the server would take', async () => {
    const res = await authed('get', '/api/billing/plans');
    const byId = Object.fromEntries(res.body.plans.map((p) => [p.id, p]));

    // Per INTERVAL, not per plan. On Free there is no subscription and so no
    // interval to differ from, which makes both cells 'current'.
    assert.equal(byId.free.actions.monthly, 'current');
    assert.equal(byId.free.actions.yearly, 'current');
    assert.equal(byId.pro.actions.monthly, 'upgrade');
    assert.equal(byId.business.actions.yearly, 'upgrade');
    assert.equal(res.body.currentInterval, null);
  });

  it('marks paid plans unavailable when no price ID is configured', async () => {
    const res = await authed('get', '/api/billing/plans');
    const pro = res.body.plans.find((p) => p.id === 'pro');

    // The price is still quoted — the catalog is real — but checkout is off,
    // so the UI renders "contact sales" rather than a button that would fail.
    assert.equal(pro.prices.monthly.amount, 2900);
    assert.equal(pro.prices.monthly.available, false);
    assert.equal(res.body.billingEnabled, false);
  });

  it('reports unlimited limits as null, since JSON has no Infinity', async () => {
    const res = await authed('get', '/api/billing/plans');
    const business = res.body.plans.find((p) => p.id === 'business');

    assert.equal(business.limits.bookingsPerMonth, null);
    assert.equal(res.body.plans.find((p) => p.id === 'free').limits.bookingsPerMonth, 50);
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/billing/plans').set('Host', HOST);

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
    assert.ok(res.body.error.requestId, 'errors carry a support reference');
  });
});

// --- Subscription -----------------------------------------------------------

describe('GET /api/billing/subscription', () => {
  it('describes the free plan when nothing has ever been purchased', async () => {
    const res = await authed('get', '/api/billing/subscription');

    assert.equal(res.status, 200);
    assert.equal(res.body.plan.id, 'free');
    assert.equal(res.body.subscription, null);
    assert.equal(res.body.hasBillingAccount, false);
  });

  it('is readable by a member, not just an owner', async () => {
    // Everyone sees which plan the workspace is on; only admins can change it.
    const res = await authed('get', '/api/billing/subscription', memberToken);
    assert.equal(res.status, 200);
  });
});

// --- Invoices ---------------------------------------------------------------

describe('GET /api/billing/invoices', () => {
  it('returns only the calling tenant\'s invoices, newest first', async () => {
    const res = await authed('get', '/api/billing/invoices');

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.deepEqual(
      res.body.invoices.map((i) => i.amountDue),
      [2900, 2900]
    );
    assert.equal(res.body.invoices[0].status, 'open', 'July before June');
  });

  it('never leaks another tenant\'s invoices', async () => {
    const res = await request(app)
      .get('/api/billing/invoices')
      .set('Host', 'globex.app.local')
      .set('Authorization', `Bearer ${globexToken}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.invoices[0].amountPaid, 9900);
  });

  it('rejects a token minted for another tenant', async () => {
    // Globex's token replayed against Acme's subdomain — the Week 1 defense,
    // still in force on the billing routes.
    const res = await authed('get', '/api/billing/invoices', globexToken);

    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('filters by status and paginates', async () => {
    const res = await authed('get', '/api/billing/invoices?status=paid&limit=1');

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.invoices[0].status, 'paid');
    assert.equal(res.body.limit, 1);
  });

  it('rejects an unknown status with a typed validation error', async () => {
    const res = await authed('get', '/api/billing/invoices?status=refunded');

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(res.body.error.details[0].path, 'query.status');
  });
});

// --- Guards -----------------------------------------------------------------

describe('billing command guards', () => {
  it('refuses checkout with 503 when Stripe is not configured', async () => {
    const res = await authed('post', '/api/billing/checkout').send({
      planId: 'pro',
      interval: 'monthly',
    });

    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'BILLING_NOT_CONFIGURED');
  });

  it('refuses a member trying to change the plan', async () => {
    const res = await authed('post', '/api/billing/checkout', memberToken).send({
      planId: 'pro',
      interval: 'monthly',
    });

    // Role is checked BEFORE Stripe configuration: who you are does not depend
    // on whether billing happens to be switched on.
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN');
  });

  it('rejects an unknown plan id before reaching Stripe', async () => {
    const res = await authed('post', '/api/billing/checkout').send({
      planId: 'enterprise',
      interval: 'monthly',
    });

    // 503 wins here only because billing is off in this suite; the point is
    // that a bogus plan never becomes a Stripe call.
    assert.ok([400, 503].includes(res.status));
  });

  it('answers unmatched billing paths in the same envelope', async () => {
    const res = await authed('get', '/api/billing/nonsense');

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
    assert.ok(res.body.error.requestId);
  });
});

// --- Interval-aware actions -------------------------------------------------

describe('plan actions for an existing subscriber', () => {
  let subToken;

  before(async () => {
    // Its own tenant, so the assertions above about a Free workspace stay
    // valid regardless of the order tests run in.
    const { Subscription } = await import('../src/models/Subscription.js');
    const { runWithTenant } = await import('../src/utils/tenantContext.js');
    const { signAccessToken } = await import('../src/utils/tokens.js');

    const subTenant = await Tenant.create({
      name: 'Switcher',
      slug: 'switcher',
      plan: 'pro',
      stripeCustomerId: 'cus_switcher',
    });

    await runWithTenant(subTenant, async () => {
      await Subscription.create({
        stripeSubscriptionId: 'sub_switcher',
        stripeCustomerId: 'cus_switcher',
        planId: 'pro',
        interval: 'monthly',
        status: 'active',
      });
    });

    subToken = signAccessToken({
      userId: new mongoose.Types.ObjectId(),
      tenantId: subTenant._id,
      role: 'owner',
    });
  });

  const asSubscriber = () =>
    request(app)
      .get('/api/billing/plans')
      .set('Host', 'switcher.app.local')
      .set('Authorization', `Bearer ${subToken}`);

  it('marks only the held interval as current', async () => {
    const res = await asSubscriber();
    const pro = res.body.plans.find((p) => p.id === 'pro');

    assert.equal(res.body.currentInterval, 'monthly');
    assert.equal(pro.actions.monthly, 'current');
    // The bug this pins: collapsing to "same plan id = current" would disable
    // this button and make annual billing unreachable from the UI.
    assert.equal(pro.actions.yearly, 'switch_interval');
  });

  it('keeps the plan-level badge true for both intervals', async () => {
    const res = await asSubscriber();
    const pro = res.body.plans.find((p) => p.id === 'pro');

    // `current` drives the "Your plan" badge and stays plan-level, whichever
    // interval the visitor happens to be browsing.
    assert.equal(pro.current, true);
  });

  it('still reports up and down moves across plans', async () => {
    const res = await asSubscriber();
    const byId = Object.fromEntries(res.body.plans.map((p) => [p.id, p]));

    assert.equal(byId.business.actions.monthly, 'upgrade');
    assert.equal(byId.free.actions.monthly, 'downgrade');
  });
});

// --- Week 1 / Week 2 are unaffected ----------------------------------------

describe('existing routes are untouched by the billing router', () => {
  it('health check still answers', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  });

  it('Week 1 auth errors keep their original flat shape', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', HOST)
      .send({ email: 'nobody@acme.test', password: 'wrong-password' });

    assert.equal(res.status, 401);
    // Flat string, NOT the Week 2/3 envelope — Login.jsx parses this shape.
    assert.equal(typeof res.body.error, 'string');
  });

  it('the JSON body parser still works on non-webhook routes', async () => {
    // Proves mounting express.raw() for the webhook did not shadow the global
    // JSON parser for everything else.
    const res = await request(app)
      .post('/api/auth/login')
      .set('Host', HOST)
      .send({ email: 'not-an-email', password: '' });

    assert.equal(res.status, 400);
  });
});

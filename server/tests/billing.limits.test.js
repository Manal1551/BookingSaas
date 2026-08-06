import { before, after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * Plan-limit enforcement.
 *
 * The rule these tests exist to pin down is the one that is easy to get wrong:
 * a plan caps how much you can CREATE, never what you can read or manage. A
 * tenant sitting over its limit — usually because it downgraded — must still
 * see, edit and cancel everything it already has. Anything else would hide a
 * customer's data behind a paywall, which is a different and much worse
 * product than "you cannot add more".
 */

let mongoose;
let mongod;
let app;
let request;
let Tenant;
let Booking;
let User;
let runWithTenant;
let signAccessToken;
let slotKeysFor;

const HOST = 'acme.app.local';

let tenant;
let token;

/** A grid-aligned window safely in the future (5-minute grid, as Week 2). */
function futureWindow(offsetMinutes = 120, durationMinutes = 60) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5);
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + durationMinutes * 60_000).toISOString(),
  };
}

let windowCounter = 0;
function validBooking(overrides = {}) {
  // Each booking gets its own window so the overlap index never interferes
  // with what these tests are actually measuring.
  windowCounter += 1;
  return {
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    serviceName: 'Consultation',
    resourceId: 'room-1',
    ...futureWindow(120 + windowCounter * 90),
    ...overrides,
  };
}

const post = (body, key = randomUUID()) =>
  request(app)
    .post('/api/bookings')
    .set('Host', HOST)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', key)
    .send(body);

const authed = (method, path) =>
  request(app)[method](path).set('Host', HOST).set('Authorization', `Bearer ${token}`);

/** Puts the tenant on a plan, the way a webhook would. */
const setPlan = (plan) => Tenant.updateOne({ _id: tenant._id }, { $set: { plan } });

/**
 * Seeds bookings directly, bypassing the API, to reach a limit quickly.
 *
 * `slotKeys` is computed with the real helper, not left blank: it is what the
 * unique overlap index is built on, so seeded rows must carry it or they all
 * collide on `undefined` and the seed fails for a reason unrelated to limits.
 * Each booking gets its own non-overlapping window for the same reason.
 */
async function seedBookings(count, resourceId = 'room-1') {
  await runWithTenant(tenant, async () => {
    for (let i = 0; i < count; i += 1) {
      windowCounter += 1;
      const { startAt, endAt } = futureWindow(60 + windowCounter * 90, 60);
      await Booking.create({
        ...validBooking({ resourceId }),
        startAt,
        endAt,
        slotKeys: slotKeysFor(startAt, endAt),
      });
    }
  });
}

before(async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri('billing_limits_test');
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-11111';
  process.env.ROOT_DOMAIN = 'app.local';
  process.env.CLIENT_ORIGIN_PATTERN = 'http://*.app.local:5173';

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI);

  request = (await import('supertest')).default;
  app = (await import('../src/app.js')).createApp();

  ({ Tenant } = await import('../src/models/Tenant.js'));
  ({ Booking } = await import('../src/models/Booking.js'));
  ({ User } = await import('../src/models/User.js'));
  ({ runWithTenant } = await import('../src/utils/tenantContext.js'));
  ({ signAccessToken } = await import('../src/utils/tokens.js'));
  ({ slotKeysFor } = await import('../src/utils/slots.js'));

  await Booking.init();

  tenant = await Tenant.create({ name: 'Acme', slug: 'acme' });
  token = signAccessToken({
    userId: new mongoose.Types.ObjectId(),
    tenantId: tenant._id,
    role: 'owner',
  });
});

after(async () => {
  await mongoose?.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  // Every test starts from a known plan and an empty ledger.
  await Booking.deleteMany({}).setOptions({ skipTenantScope: true });
  await User.deleteMany({}).setOptions({ skipTenantScope: true });
  await setPlan('free');
});

// --- Booking volume ---------------------------------------------------------

describe('bookingsPerMonth limit', () => {
  it('allows a booking while under the limit', async () => {
    await seedBookings(10);
    const res = await post(validBooking());
    assert.equal(res.status, 201);
  });

  it('blocks with 402 PLAN_LIMIT_EXCEEDED once the limit is reached', async () => {
    await seedBookings(50); // Free allows 50/month

    const res = await post(validBooking());

    assert.equal(res.status, 402, '402 says "upgrade and you may", unlike 403');
    assert.equal(res.body.error.code, 'PLAN_LIMIT_EXCEEDED');
    assert.match(res.body.error.message, /Free plan this month/);
    assert.ok(res.body.error.requestId);
  });

  it('lets the same request through immediately after an upgrade', async () => {
    await seedBookings(50);
    assert.equal((await post(validBooking())).status, 402);

    // A webhook raising the plan is all it takes — the check re-reads the
    // tenant rather than trusting the one cached at the start of the request.
    await setPlan('pro');

    assert.equal((await post(validBooking())).status, 201);
  });

  it('never burns the Idempotency-Key on a rejected request', async () => {
    await seedBookings(50);
    const key = randomUUID();
    const body = validBooking();

    assert.equal((await post(body, key)).status, 402);

    // Upgrade, then retry with the SAME key: it must create the booking rather
    // than replay a stored rejection or report key reuse.
    await setPlan('pro');
    const retry = await post(body, key);

    assert.equal(retry.status, 201);
    assert.equal(retry.headers['idempotent-replay'], undefined);
  });

  it('imposes no limit on the unlimited plan', async () => {
    await setPlan('business');
    await seedBookings(60);

    const res = await post(validBooking());
    assert.equal(res.status, 201);
  });
});

// --- Resources --------------------------------------------------------------

describe('resources limit', () => {
  it('allows more bookings on a resource already in use', async () => {
    // Free allows 1 resource. Re-booking that same resource must keep working
    // even at the limit — the cap is on distinct resources, not on volume.
    await seedBookings(3, 'room-1');

    const res = await post(validBooking({ resourceId: 'room-1' }));
    assert.equal(res.status, 201);
  });

  it('blocks a NEW resource beyond the limit', async () => {
    await seedBookings(1, 'room-1');

    const res = await post(validBooking({ resourceId: 'room-2' }));

    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'PLAN_LIMIT_EXCEEDED');
    assert.match(res.body.error.message, /bookable resource/);
    assert.equal(res.body.error.details[0].path, 'body.resourceId');
  });

  it('allows the new resource once the plan covers it', async () => {
    await seedBookings(1, 'room-1');
    assert.equal((await post(validBooking({ resourceId: 'room-2' }))).status, 402);

    await setPlan('pro'); // 25 resources
    assert.equal((await post(validBooking({ resourceId: 'room-2' }))).status, 201);
  });
});

// --- Reads and edits stay open ---------------------------------------------

describe('being over a limit never restricts existing data', () => {
  it('still lists every booking', async () => {
    await seedBookings(55);

    const res = await authed('get', '/api/bookings?limit=100');

    assert.equal(res.status, 200);
    assert.equal(res.body.total, 55, 'nothing is hidden behind the limit');
  });

  it('still allows editing and cancelling', async () => {
    await seedBookings(55);
    const list = await authed('get', '/api/bookings?limit=1');
    const booking = list.body.bookings[0];

    const patch = await authed('patch', `/api/bookings/${booking.id}`)
      .set('If-Match', String(booking.version))
      .send({ notes: 'Edited while over the limit' });
    assert.equal(patch.status, 200);

    const del = await authed('delete', `/api/bookings/${booking.id}`);
    assert.equal(del.status, 204);
  });

  it('reports the overage honestly rather than clamping it', async () => {
    await seedBookings(55); // A tenant that downgraded while over.

    const res = await authed('get', '/api/billing/usage');

    assert.equal(res.status, 200);
    assert.equal(res.body.usage.bookingsPerMonth.used, 55);
    assert.equal(res.body.usage.bookingsPerMonth.limit, 50);
    assert.equal(res.body.usage.bookingsPerMonth.remaining, 0);
    assert.equal(res.body.usage.bookingsPerMonth.exceeded, true);
  });
});

// --- Usage endpoint ---------------------------------------------------------

describe('GET /api/billing/usage', () => {
  it('reports usage against the current plan', async () => {
    await seedBookings(4, 'room-1');

    const res = await authed('get', '/api/billing/usage');

    assert.equal(res.status, 200);
    assert.equal(res.body.planId, 'free');
    assert.equal(res.body.usage.bookingsPerMonth.used, 4);
    assert.equal(res.body.usage.bookingsPerMonth.remaining, 46);
    assert.equal(res.body.usage.resources.used, 1);
    assert.equal(res.body.usage.resources.limit, 1);
  });

  it('reports unlimited limits as null', async () => {
    await setPlan('business');

    const res = await authed('get', '/api/billing/usage');

    assert.equal(res.body.usage.bookingsPerMonth.limit, null);
    assert.equal(res.body.usage.bookingsPerMonth.remaining, null);
    assert.equal(res.body.usage.bookingsPerMonth.exceeded, false);
  });

  it('reports a usage window that is the current calendar month', async () => {
    const res = await authed('get', '/api/billing/usage');

    const start = new Date(res.body.periodStart);
    assert.equal(start.getUTCDate(), 1);
    assert.equal(start.getUTCHours(), 0);
    assert.ok(new Date(res.body.periodEnd) > start);
  });
});

// --- Seats ------------------------------------------------------------------

describe('teamMembers limit on register', () => {
  const registerUser = (email) =>
    request(app)
      .post('/api/auth/register')
      .set('Host', HOST)
      .send({ name: 'New Person', email, password: 'Password123!' });

  it('always allows the FIRST user, whatever the plan', async () => {
    // A workspace nobody can register into would be unreachable — no plan
    // should be able to produce that.
    const res = await registerUser('owner@acme.test');
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'owner');
  });

  it('blocks the seat beyond the plan with 402', async () => {
    await registerUser('owner@acme.test');
    await registerUser('second@acme.test'); // Free allows 2

    const res = await registerUser('third@acme.test');

    assert.equal(res.status, 402);
    // Week 1's FLAT error shape — the Register page parses this, and Week 3
    // must not change a contract it already relies on.
    assert.equal(typeof res.body.error, 'string');
    assert.match(res.body.error, /Free plan includes 2 team members/);
  });

  it('allows the seat once the plan covers it', async () => {
    await registerUser('owner@acme.test');
    await registerUser('second@acme.test');
    assert.equal((await registerUser('third@acme.test')).status, 402);

    await setPlan('pro'); // 15 seats
    assert.equal((await registerUser('third@acme.test')).status, 201);
  });

  it('counts seats in the usage report', async () => {
    await registerUser('owner@acme.test');

    const res = await authed('get', '/api/billing/usage');
    assert.equal(res.body.usage.teamMembers.used, 1);
    assert.equal(res.body.usage.teamMembers.limit, 2);
  });
});

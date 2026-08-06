import test, { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

/**
 * End-to-end tests for the Booking API against a real MongoDB (in-memory).
 *
 * `config/env.js` validates and freezes the environment the moment it is
 * imported, so every env var must be set BEFORE any application module is
 * pulled in — hence the dynamic imports in `before()`. dotenv does not
 * override values already present in process.env, so the .env on disk cannot
 * point these tests at the developer's real database.
 */

let mongoose;
let mongod;
let app;
let request;
let Booking;
let IdempotencyKey;
let tenant;
let token;

const HOST = 'acme.app.local';

/** A grid-aligned window safely in the future. */
function futureWindow({ offsetMinutes = 120, durationMinutes = 60 } = {}) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

let resourceCounter = 0;
/** Each test gets its own resource so slot conflicts never leak between them. */
const nextResource = () => `room-${resourceCounter++}`;

function validBooking(overrides = {}) {
  return {
    customerName: 'Ada Lovelace',
    customerEmail: 'ada@example.com',
    serviceName: 'Design consultation',
    resourceId: nextResource(),
    ...futureWindow(),
    ...overrides,
  };
}

/** POST helper that always carries auth + host, and a key unless told not to. */
function post(body, { key = randomUUID(), headers = {} } = {}) {
  const req = request(app)
    .post('/api/bookings')
    .set('Host', HOST)
    .set('Authorization', `Bearer ${token}`)
    .set(headers);
  if (key !== null) req.set('Idempotency-Key', key);
  return req.send(body);
}

const authed = (method, path) =>
  request(app)[method](path).set('Host', HOST).set('Authorization', `Bearer ${token}`);

before(async () => {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  mongod = await MongoMemoryServer.create();

  process.env.NODE_ENV = 'test';
  process.env.MONGODB_URI = mongod.getUri('booking_test');
  process.env.JWT_ACCESS_SECRET = 'test-access-secret-that-is-long-enough-000000';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-that-is-long-enough-11111';
  process.env.ROOT_DOMAIN = 'app.local';
  process.env.CLIENT_ORIGIN_PATTERN = 'http://*.app.local:5173';

  mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI);

  request = (await import('supertest')).default;
  app = (await import('../src/app.js')).createApp();

  const { Tenant } = await import('../src/models/Tenant.js');
  ({ Booking } = await import('../src/models/Booking.js'));
  ({ IdempotencyKey } = await import('../src/models/IdempotencyKey.js'));

  // The unique slot index and the idempotency-key index must exist before the
  // concurrency tests run — they are what makes the races safe.
  await Booking.init();
  await IdempotencyKey.init();

  // `business` (unlimited) on purpose: Week 3 added plan-limit enforcement to
  // POST /api/bookings, and these tests are about booking SEMANTICS —
  // idempotency, overlap, optimistic concurrency — not about entitlements.
  // Leaving the fixture on the default `free` plan would cap it at one
  // resource and make half of them fail for a reason they are not testing.
  // Limit enforcement has its own suite: billing.limits.test.js.
  tenant = await Tenant.create({ name: 'Acme', slug: 'acme', plan: 'business' });

  const { signAccessToken } = await import('../src/utils/tokens.js');
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

// --- Idempotency ------------------------------------------------------------

describe('POST /api/bookings — idempotency', () => {
  it('replays the stored response for a repeated key and creates ONE row', async () => {
    const key = randomUUID();
    const body = validBooking();

    const first = await post(body, { key });
    assert.equal(first.status, 201);
    assert.equal(first.headers['idempotent-replay'], undefined);

    const second = await post(body, { key });
    assert.equal(second.status, 201, 'replay returns the ORIGINAL status');
    assert.equal(second.headers['idempotent-replay'], 'true');
    assert.deepEqual(second.body, first.body, 'replay is byte-identical');

    const count = await Booking.countDocuments({ resourceId: body.resourceId })
      .setOptions({ skipTenantScope: true });
    assert.equal(count, 1, 'the second call must not create a second booking');
  });

  it('rejects the same key with a different body (409 IDEMPOTENCY_KEY_REUSE)', async () => {
    const key = randomUUID();
    const first = await post(validBooking(), { key });
    assert.equal(first.status, 201);

    const reused = await post(validBooking({ customerName: 'Someone Else' }), { key });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSE');
  });

  it('creates exactly one booking when duplicates are fired in parallel', async () => {
    const key = randomUUID();
    const body = validBooking();

    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post(body, { key }))
    );

    const created = responses.filter((r) => r.status === 201 && !r.headers['idempotent-replay']);
    assert.equal(created.length, 1, 'exactly one request may perform the create');

    // Everyone else is either told it is in flight, or replayed the winner.
    for (const r of responses.filter((x) => !created.includes(x))) {
      const replayed = r.status === 201 && r.headers['idempotent-replay'] === 'true';
      const inFlight = r.status === 409 && r.body.error.code === 'REQUEST_IN_PROGRESS';
      assert.ok(
        replayed || inFlight,
        `unexpected duplicate outcome: ${r.status} ${JSON.stringify(r.body)}`
      );
    }

    const count = await Booking.countDocuments({ resourceId: body.resourceId })
      .setOptions({ skipTenantScope: true });
    assert.equal(count, 1, 'the DB must hold exactly one booking');
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await post(validBooking(), { key: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    assert.equal(res.body.error.details[0].path, 'headers.Idempotency-Key');
  });

  it('rejects a non-UUID Idempotency-Key', async () => {
    const res = await post(validBooking(), { key: 'not-a-uuid' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('frees the key when the attempt fails, so a corrected retry can reuse it', async () => {
    const key = randomUUID();
    const resource = nextResource();

    const bad = await post(validBooking({ resourceId: resource, notes: 'x'.repeat(2001) }), { key });
    assert.equal(bad.status, 400);

    const stored = await IdempotencyKey.findOne({ key }).setOptions({ skipTenantScope: true });
    assert.equal(stored, null, 'a failed attempt must not burn the key');
  });
});

// --- Double-booking ---------------------------------------------------------

describe('POST /api/bookings — overlap constraint', () => {
  it('rejects an overlapping booking on the same resource (409 BOOKING_CONFLICT)', async () => {
    const resource = nextResource();
    const window = futureWindow({ offsetMinutes: 300, durationMinutes: 60 });

    const first = await post(validBooking({ resourceId: resource, ...window }));
    assert.equal(first.status, 201);

    // Starts 30 minutes into the first booking.
    const overlapStart = new Date(new Date(window.startAt).getTime() + 30 * 60_000);
    const overlapEnd = new Date(overlapStart.getTime() + 60 * 60_000);
    const second = await post(
      validBooking({
        resourceId: resource,
        startAt: overlapStart.toISOString(),
        endAt: overlapEnd.toISOString(),
      })
    );

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'BOOKING_CONFLICT');
  });

  it('allows back-to-back bookings (the range is half-open)', async () => {
    const resource = nextResource();
    const window = futureWindow({ offsetMinutes: 600, durationMinutes: 30 });

    const first = await post(validBooking({ resourceId: resource, ...window }));
    assert.equal(first.status, 201);

    const second = await post(
      validBooking({
        resourceId: resource,
        startAt: window.endAt,
        endAt: new Date(new Date(window.endAt).getTime() + 30 * 60_000).toISOString(),
      })
    );
    assert.equal(second.status, 201, 'touching bookings do not overlap');
  });

  it('allows the same window on a DIFFERENT resource', async () => {
    const window = futureWindow({ offsetMinutes: 900 });
    const a = await post(validBooking({ resourceId: nextResource(), ...window }));
    const b = await post(validBooking({ resourceId: nextResource(), ...window }));
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
  });

  it('frees the slot once a booking is cancelled', async () => {
    const resource = nextResource();
    const window = futureWindow({ offsetMinutes: 1200 });

    const first = await post(validBooking({ resourceId: resource, ...window }));
    assert.equal(first.status, 201);

    const cancelled = await authed('patch', `/api/bookings/${first.body.booking.id}`)
      .set('If-Match', String(first.body.booking.version))
      .send({ status: 'cancelled' });
    assert.equal(cancelled.status, 200);

    const rebooked = await post(validBooking({ resourceId: resource, ...window }));
    assert.equal(rebooked.status, 201, 'a cancelled booking must release its slots');
  });
});

// --- Optimistic concurrency -------------------------------------------------

describe('PATCH /api/bookings/:id — optimistic concurrency', () => {
  it('applies an update carrying the current version and bumps it', async () => {
    const created = await post(validBooking());
    const { id, version } = created.body.booking;

    const res = await authed('patch', `/api/bookings/${id}`)
      .set('If-Match', String(version))
      .send({ notes: 'Bring the deck' });

    assert.equal(res.status, 200);
    assert.equal(res.body.booking.notes, 'Bring the deck');
    assert.equal(res.body.booking.version, version + 1);
  });

  it('rejects a stale version with 409 STALE_RESOURCE', async () => {
    const created = await post(validBooking());
    const { id, version } = created.body.booking;

    const ok = await authed('patch', `/api/bookings/${id}`)
      .set('If-Match', String(version))
      .send({ notes: 'first write wins' });
    assert.equal(ok.status, 200);

    const stale = await authed('patch', `/api/bookings/${id}`)
      .set('If-Match', String(version))
      .send({ notes: 'second write loses' });

    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'STALE_RESOURCE');
  });

  it('requires a version', async () => {
    const created = await post(validBooking());
    const res = await authed('patch', `/api/bookings/${created.body.booking.id}`)
      .send({ notes: 'no version' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('accepts the version in the body as well as If-Match', async () => {
    const created = await post(validBooking());
    const { id, version } = created.body.booking;

    const res = await authed('patch', `/api/bookings/${id}`).send({
      version,
      status: 'confirmed',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.booking.status, 'confirmed');
  });

  it('404s for an unknown id', async () => {
    const res = await authed('patch', `/api/bookings/${new mongoose.Types.ObjectId()}`)
      .set('If-Match', '0')
      .send({ notes: 'nope' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

// --- Delete -----------------------------------------------------------------

describe('DELETE /api/bookings/:id — idempotent', () => {
  it('returns 204 twice and never errors', async () => {
    const created = await post(validBooking());
    const { id } = created.body.booking;

    const first = await authed('delete', `/api/bookings/${id}`);
    assert.equal(first.status, 204);

    const second = await authed('delete', `/api/bookings/${id}`);
    assert.equal(second.status, 204, 'repeat delete is success, not 404 or 500');
  });

  it('returns 204 for an id that never existed', async () => {
    const res = await authed('delete', `/api/bookings/${new mongoose.Types.ObjectId()}`);
    assert.equal(res.status, 204);
  });
});

// --- Validation rules -------------------------------------------------------

describe('Zod validation', () => {
  const cases = [
    ['a past start time', { ...futureWindow(), startAt: '2020-01-01T10:00:00.000Z', endAt: '2020-01-01T11:00:00.000Z' }, 'body.startAt'],
    ['end before start', (() => { const w = futureWindow(); return { startAt: w.endAt, endAt: w.startAt }; })(), 'body.endAt'],
    ['a duration over the 8h cap', (() => { const w = futureWindow({ durationMinutes: 9 * 60 }); return w; })(), 'body.endAt'],
    ['a start off the 5-minute grid', (() => { const w = futureWindow(); const s = new Date(w.startAt); s.setUTCMinutes(s.getUTCMinutes() + 2); return { startAt: s.toISOString(), endAt: w.endAt }; })(), 'body.startAt'],
    ['a malformed email', { customerEmail: 'not-an-email' }, 'body.customerEmail'],
    ['an over-long note', { notes: 'x'.repeat(2001) }, 'body.notes'],
    ['a bad status', { status: 'archived' }, 'body.status'],
    ['a missing resourceId', { resourceId: undefined }, 'body.resourceId'],
  ];

  for (const [label, overrides, expectedPath] of cases) {
    it(`rejects ${label}`, async () => {
      const body = validBooking(overrides);
      if (overrides.resourceId === undefined && 'resourceId' in overrides) delete body.resourceId;

      const res = await post(body);
      assert.equal(res.status, 400, `expected 400, got ${res.status}`);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
      assert.ok(
        res.body.error.details.some((d) => d.path === expectedPath),
        `expected a detail at ${expectedPath}, got ${JSON.stringify(res.body.error.details)}`
      );
    });
  }

  it('rejects unknown keys (schemas are strict)', async () => {
    const res = await post(validBooking({ bogus: 'nope' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });

  it('rejects a malformed :id', async () => {
    const res = await authed('get', '/api/bookings/not-an-id');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].path, 'params.id');
  });

  it('rejects an unknown query parameter', async () => {
    const res = await authed('get', '/api/bookings?nope=1');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});

// --- Envelope + listing -----------------------------------------------------

describe('error envelope and listing', () => {
  it('always carries code, message and requestId, and echoes X-Request-Id', async () => {
    const res = await authed('get', `/api/bookings/${new mongoose.Types.ObjectId()}`);
    assert.equal(res.status, 404);
    assert.equal(typeof res.body.error.code, 'string');
    assert.equal(typeof res.body.error.message, 'string');
    assert.equal(typeof res.body.error.requestId, 'string');
    assert.equal(res.headers['x-request-id'], res.body.error.requestId);
  });

  it('honours a caller-supplied X-Request-Id', async () => {
    const res = await authed('get', `/api/bookings/${new mongoose.Types.ObjectId()}`)
      .set('X-Request-Id', 'req_from_caller');
    assert.equal(res.body.error.requestId, 'req_from_caller');
  });

  it('returns 401 without a token, in the new envelope', async () => {
    const res = await request(app).get('/api/bookings').set('Host', HOST);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  it('filters by resourceId and paginates', async () => {
    const resource = nextResource();
    const base = futureWindow({ offsetMinutes: 2000 });
    for (let i = 0; i < 3; i += 1) {
      const start = new Date(new Date(base.startAt).getTime() + i * 60 * 60_000);
      await post(
        validBooking({
          resourceId: resource,
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
        })
      );
    }

    const res = await authed('get', `/api/bookings?resourceId=${resource}&limit=2&page=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.bookings.length, 2);
    assert.equal(res.body.hasMore, true);
    assert.equal(res.body.totalPages, 2);
  });
});

/**
 * End-to-end check for the Booking API (mirrors verify-isolation.js).
 *
 * Boots the app on an isolated port, logs in as a seeded Acme user to get a
 * real access cookie, then proves the Week 2 contract against a real MongoDB:
 *
 *   lifecycle        create -> list -> get -> patch -> delete (204, twice)
 *   idempotency      same key + same body  -> replayed response, ONE row
 *                    same key + diff body  -> 409 IDEMPOTENCY_KEY_REUSE
 *                    parallel duplicates   -> exactly one booking
 *   overlap          same resource + window -> 409 BOOKING_CONFLICT
 *                    back-to-back           -> allowed
 *   concurrency      stale If-Match         -> 409 STALE_RESOURCE
 *   envelope         { error: { code, message, details, requestId } }
 *                    + X-Request-Id on every response
 *
 * Cleans up everything it creates. Exits 0 only if every assertion passes.
 *
 * Run: npm run seed   then   npm run verify:bookings
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { Tenant } from '../src/models/Tenant.js';
import { Booking } from '../src/models/Booking.js';
import { IdempotencyKey } from '../src/models/IdempotencyKey.js';
import { runWithTenant } from '../src/utils/tenantContext.js';

const PORT = 5597; // isolated port, distinct from verify-isolation
const HOST = `acme.${env.ROOT_DOMAIN}`;
const RESOURCE_PREFIX = `verify-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function request(method, path, { cookie, json, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json ? JSON.stringify(json) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        headers: {
          Host: HOST,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A grid-aligned window in the future, offset so tests never collide. */
function futureWindow({ offsetMinutes = 60, durationMinutes = 60 } = {}) {
  const start = new Date(Date.now() + offsetMinutes * 60_000);
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(Math.ceil(start.getUTCMinutes() / 5) * 5);
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

let resourceSeq = 0;
const nextResource = () => `${RESOURCE_PREFIX}-${resourceSeq++}`;

function booking(overrides = {}) {
  return {
    customerName: 'Verify Bot',
    customerEmail: 'verify@example.com',
    serviceName: 'Automated check',
    resourceId: nextResource(),
    ...futureWindow(),
    ...overrides,
  };
}

async function main() {
  await connectDb();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = http.createServer(app).listen(PORT, '127.0.0.1', () => resolve(s));
  });

  try {
    // --- Login as a seeded Acme user ---------------------------------------
    console.log('\nAuth');
    const login = await request('POST', '/api/auth/login', {
      json: { email: 'alice@acme.test', password: 'Password123!' },
    });
    check('logged in as alice@acme.test', login.status === 200, JSON.stringify(login.body));

    if (login.status !== 200) {
      console.error('\nCannot continue without a session. Did you run `npm run seed`?');
      process.exitCode = 1;
      return;
    }

    const cookie = (login.headers['set-cookie'] || [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const auth = (extra = {}) => ({ cookie, headers: extra });

    // --- Lifecycle ----------------------------------------------------------
    console.log('\nLifecycle');
    const created = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      json: booking(),
    });
    check('create returns 201', created.status === 201, JSON.stringify(created.body));
    check('response carries X-Request-Id', Boolean(created.headers['x-request-id']));

    const id = created.body?.booking?.id;
    const version = created.body?.booking?.version;
    check('booking has a version token', version === 0, `version=${version}`);

    const got = await request('GET', `/api/bookings/${id}`, auth());
    check('get by id returns 200', got.status === 200);

    const listed = await request('GET', '/api/bookings?limit=200', auth());
    check(
      'list includes the new booking',
      Array.isArray(listed.body?.bookings) && listed.body.bookings.some((b) => b.id === id)
    );

    const patched = await request('PATCH', `/api/bookings/${id}`, {
      cookie,
      headers: { 'If-Match': String(version) },
      json: { status: 'confirmed', notes: 'verified' },
    });
    check('patch with current version returns 200', patched.status === 200);
    check('version was bumped', patched.body?.booking?.version === version + 1);

    const stale = await request('PATCH', `/api/bookings/${id}`, {
      cookie,
      headers: { 'If-Match': String(version) },
      json: { notes: 'stale write' },
    });
    check(
      'patch with a stale version returns 409 STALE_RESOURCE',
      stale.status === 409 && stale.body?.error?.code === 'STALE_RESOURCE',
      JSON.stringify(stale.body)
    );

    const del1 = await request('DELETE', `/api/bookings/${id}`, auth());
    const del2 = await request('DELETE', `/api/bookings/${id}`, auth());
    check('delete returns 204', del1.status === 204);
    check('deleting twice is still 204 (idempotent)', del2.status === 204);

    // --- Idempotency --------------------------------------------------------
    console.log('\nIdempotency');
    const key = randomUUID();
    const body = booking();

    const first = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': key },
      json: body,
    });
    const replay = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': key },
      json: body,
    });

    check('first call creates (201)', first.status === 201);
    check('replay returns the original status', replay.status === first.status);
    check('replay is flagged Idempotent-Replay: true', replay.headers['idempotent-replay'] === 'true');
    check(
      'replay returns the identical body',
      JSON.stringify(replay.body) === JSON.stringify(first.body)
    );

    const reuse = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': key },
      json: { ...body, customerName: 'Different Person' },
    });
    check(
      'same key + different body returns 409 IDEMPOTENCY_KEY_REUSE',
      reuse.status === 409 && reuse.body?.error?.code === 'IDEMPOTENCY_KEY_REUSE',
      JSON.stringify(reuse.body)
    );

    const noKey = await request('POST', '/api/bookings', { cookie, json: booking() });
    check(
      'missing Idempotency-Key returns 400 pointing at the header',
      noKey.status === 400 &&
        noKey.body?.error?.details?.[0]?.path === 'headers.Idempotency-Key',
      JSON.stringify(noKey.body)
    );

    // Parallel duplicates: exactly one booking may be created.
    const parallelKey = randomUUID();
    const parallelBody = booking();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request('POST', '/api/bookings', {
          cookie,
          headers: { 'Idempotency-Key': parallelKey },
          json: parallelBody,
        })
      )
    );
    const fresh = responses.filter(
      (r) => r.status === 201 && r.headers['idempotent-replay'] !== 'true'
    );
    check(
      'five parallel duplicates perform exactly one create',
      fresh.length === 1,
      `statuses: ${responses.map((r) => r.status).join(', ')}`
    );
    const acmeTenant = await Tenant.findOne({ slug: 'acme' })
      .setOptions({ skipTenantScope: true })
      .lean();
    // Await INSIDE the context: a lazy Mongoose query returned from
    // runWithTenant would otherwise execute after the context has closed.
    const parallelRows = await runWithTenant(acmeTenant, async () => {
      return await Booking.countDocuments({ resourceId: parallelBody.resourceId });
    });
    check('...and the database holds exactly one row', parallelRows === 1, `rows=${parallelRows}`);

    // --- Overlap ------------------------------------------------------------
    console.log('\nDouble-booking');
    const sharedResource = nextResource();
    const window = futureWindow({ offsetMinutes: 400 });

    const a = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      json: booking({ resourceId: sharedResource, ...window }),
    });
    check('first booking on the resource is created', a.status === 201);

    const overlapStart = new Date(new Date(window.startAt).getTime() + 30 * 60_000);
    const overlap = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      json: booking({
        resourceId: sharedResource,
        startAt: overlapStart.toISOString(),
        endAt: new Date(overlapStart.getTime() + 60 * 60_000).toISOString(),
      }),
    });
    check(
      'an overlapping booking returns 409 BOOKING_CONFLICT',
      overlap.status === 409 && overlap.body?.error?.code === 'BOOKING_CONFLICT',
      JSON.stringify(overlap.body)
    );

    const adjacent = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      json: booking({
        resourceId: sharedResource,
        startAt: window.endAt,
        endAt: new Date(new Date(window.endAt).getTime() + 30 * 60_000).toISOString(),
      }),
    });
    check('a back-to-back booking is allowed', adjacent.status === 201, JSON.stringify(adjacent.body));

    // --- Error envelope -----------------------------------------------------
    console.log('\nError envelope');
    const invalid = await request('POST', '/api/bookings', {
      cookie,
      headers: { 'Idempotency-Key': randomUUID() },
      json: booking({ customerEmail: 'nope', startAt: '2020-01-01T10:00:00.000Z' }),
    });
    const err = invalid.body?.error;
    check('validation failure returns 400', invalid.status === 400);
    check('envelope has code/message/requestId', Boolean(err?.code && err?.message && err?.requestId));
    check('envelope carries details[]', Array.isArray(err?.details) && err.details.length > 0);
    check(
      'requestId matches the X-Request-Id header',
      err?.requestId === invalid.headers['x-request-id']
    );

    const missing = await request('GET', '/api/bookings/507f1f77bcf86cd799439011', auth());
    check(
      'unknown id returns 404 NOT_FOUND',
      missing.status === 404 && missing.body?.error?.code === 'NOT_FOUND'
    );

    const badId = await request('GET', '/api/bookings/not-an-id', auth());
    check(
      'malformed id returns 400 pointing at params.id',
      badId.status === 400 && badId.body?.error?.details?.[0]?.path === 'params.id'
    );

    const anon = await request('GET', '/api/bookings');
    check(
      'no credentials returns 401 UNAUTHORIZED',
      anon.status === 401 && anon.body?.error?.code === 'UNAUTHORIZED'
    );
  } finally {
    // --- Cleanup ------------------------------------------------------------
    const tenant = await Tenant.findOne({ slug: 'acme' })
      .setOptions({ skipTenantScope: true })
      .lean();

    if (tenant) {
      // runWithTenant takes the tenant DOC (it derives tenantId internally);
      // passing a pre-built store object leaves tenantId undefined and the
      // scope plugin then refuses the deleteMany.
      await runWithTenant(tenant, async () => {
        await Booking.deleteMany({ resourceId: new RegExp(`^${RESOURCE_PREFIX}`) });
        await IdempotencyKey.deleteMany({});
      });
    }

    await new Promise((resolve) => server.close(resolve));
    await disconnectDb();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nverify-bookings crashed:', err);
  process.exitCode = 1;
});

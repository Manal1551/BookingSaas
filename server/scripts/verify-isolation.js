/**
 * Proves tenant isolation end-to-end, two ways:
 *
 *  (A) HTTP layer — logs in as an Acme user, then replays that token against
 *      Globex's subdomain. The token/subdomain double-check must return 403.
 *
 *  (B) Data layer — queries Users inside the Acme context and the Globex
 *      context and confirms the result sets never overlap (the Mongoose
 *      scoping plugin injects tenantId automatically).
 *
 * Exits 0 only if every assertion passes; exits 1 otherwise.
 *
 * Run: npm run verify:isolation   (seed first so data exists)
 */
import http from 'node:http';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { createApp } from '../src/app.js';
import { Tenant } from '../src/models/Tenant.js';
import { User } from '../src/models/User.js';
import { runWithTenant } from '../src/utils/tenantContext.js';

const PORT = 5599; // isolated test port

// Minimal HTTP client that lets us fully control the Host header (the subdomain
// under test) and pass cookies. Returns { status, body, cookies }.
function request(method, path, { host, cookie, json } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json ? JSON.stringify(json) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        method,
        path,
        headers: {
          Host: host, // <-- the tenant subdomain we are pretending to be on
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
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
          resolve({
            status: res.statusCode,
            body: parsed,
            cookies: res.headers['set-cookie'] || [],
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function accessCookieFrom(setCookies) {
  const c = setCookies.find((s) => s.startsWith('access_token='));
  return c ? c.split(';')[0] : null;
}

let failures = 0;
function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.log(`  ❌ ${label}`);
    failures += 1;
  }
}

async function run() {
  await connectDb();
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, () => resolve(s));
  });

  const ACME = 'acme.app.local';
  const GLOBEX = 'globex.app.local';
  const PASSWORD = 'Password123!';

  try {
    console.log('\n── (A) HTTP-layer cross-tenant token replay ──');

    // 1. Log in as an Acme user on the Acme subdomain.
    const login = await request('POST', '/api/auth/login', {
      host: ACME,
      json: { email: 'alice@acme.test', password: PASSWORD },
    });
    assert('login on acme succeeds (200)', login.status === 200);
    const acmeCookie = accessCookieFrom(login.cookies);
    assert('received access cookie', Boolean(acmeCookie));

    // 2. Control: the Acme token works on Acme's own subdomain.
    const meOnAcme = await request('GET', '/api/auth/me', {
      host: ACME,
      cookie: acmeCookie,
    });
    assert('acme token → /me on acme works (200)', meOnAcme.status === 200);

    // 3. Attack: replay the Acme token against Globex's subdomain.
    const meOnGlobex = await request('GET', '/api/auth/me', {
      host: GLOBEX,
      cookie: acmeCookie,
    });
    assert(
      'acme token → /me on globex is REJECTED (403)',
      meOnGlobex.status === 403
    );

    console.log('\n── (B) Data-layer scoping via Mongoose plugin ──');

    const acme = await Tenant.findOne({ slug: 'acme' })
      .setOptions({ skipTenantScope: true })
      .lean();
    const globex = await Tenant.findOne({ slug: 'globex' })
      .setOptions({ skipTenantScope: true })
      .lean();

    const acmeEmails = await runWithTenant(acme, async () =>
      (await User.find().lean()).map((u) => String(u._id))
    );
    const globexEmails = await runWithTenant(globex, async () =>
      (await User.find().lean()).map((u) => String(u._id))
    );

    assert('acme returns some users', acmeEmails.length > 0);
    assert('globex returns some users', globexEmails.length > 0);
    const overlap = acmeEmails.filter((id) => globexEmails.includes(id));
    assert('no user document appears in both tenants', overlap.length === 0);

    // A find() with no tenant in context must throw (fail-closed).
    let threw = false;
    try {
      await User.find().lean();
    } catch {
      threw = true;
    }
    assert('User.find() with NO tenant context throws (fail-closed)', threw);
  } finally {
    await new Promise((r) => server.close(r));
    await disconnectDb();
  }

  if (failures === 0) {
    console.log('\n✨ All isolation checks passed.');
    process.exit(0);
  } else {
    console.log(`\n💥 ${failures} isolation check(s) FAILED.`);
    process.exit(1);
  }
}

run().catch(async (err) => {
  console.error('verify-isolation crashed:', err);
  await disconnectDb().catch(() => {});
  process.exit(1);
});

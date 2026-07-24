/**
 * Idempotent seed script.
 *
 * Creates 3 tenants (acme, globex, initech), each with several realistic users.
 * Clears the collections first so re-running always yields the same state.
 * Prints the plaintext seed passwords and a per-tenant user count at the end.
 *
 * Run: npm run seed   (from repo root)  or  node scripts/seed.js (from server/)
 */
import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Tenant } from '../src/models/Tenant.js';
import { User } from '../src/models/User.js';
import { runWithTenant } from '../src/utils/tenantContext.js';

const BCRYPT_ROUNDS = 12;

// Shared password for every seeded account (dev only), printed below.
const SEED_PASSWORD = 'Password123!';

const TENANTS = [
  {
    name: 'Acme Corporation',
    slug: 'acme',
    plan: 'pro',
    users: [
      { name: 'Alice Reyes', email: 'alice@acme.test', role: 'owner' },
      { name: 'Marcus Bell', email: 'marcus@acme.test', role: 'admin' },
      { name: 'Priya Nair', email: 'priya@acme.test', role: 'member' },
      { name: 'Tom Whitfield', email: 'tom@acme.test', role: 'member' },
    ],
  },
  {
    name: 'Globex Industries',
    slug: 'globex',
    plan: 'free',
    users: [
      { name: 'Hank Scorpio', email: 'hank@globex.test', role: 'owner' },
      { name: 'Dana Ito', email: 'dana@globex.test', role: 'admin' },
      { name: 'Leo Fontaine', email: 'leo@globex.test', role: 'member' },
      // Same email local-part as an Acme user — proves per-tenant uniqueness.
      { name: 'Alice Cooper', email: 'alice@acme.test', role: 'member' },
    ],
  },
  {
    name: 'Initech LLC',
    slug: 'initech',
    plan: 'free',
    users: [
      { name: 'Bill Lumbergh', email: 'bill@initech.test', role: 'owner' },
      { name: 'Peter Gibbons', email: 'peter@initech.test', role: 'admin' },
      { name: 'Samir Nagheenanajar', email: 'samir@initech.test', role: 'member' },
      { name: 'Michael Bolton', email: 'michael@initech.test', role: 'member' },
      { name: 'Milton Waddams', email: 'milton@initech.test', role: 'member' },
    ],
  },
];

async function run() {
  await connectDb();

  console.log('🧹 Clearing existing tenants and users...');
  await Tenant.deleteMany({}).setOptions({ skipTenantScope: true });
  // Users are tenant-scoped; delete directly on the collection to bypass the
  // scope guard (there is no tenant context here).
  await mongoose.connection.collection('users').deleteMany({});

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);

  for (const t of TENANTS) {
    const tenant = await Tenant.create({
      name: t.name,
      slug: t.slug,
      plan: t.plan,
    });

    // Bind tenant context so the scope plugin stamps tenantId on every user.
    await runWithTenant(tenant, async () => {
      for (const u of t.users) {
        await User.create({
          name: u.name,
          email: u.email,
          role: u.role,
          passwordHash,
        });
      }
    });

    console.log(`✅ Seeded tenant "${t.slug}" with ${t.users.length} users`);
  }

  // Prove data landed: one count query per tenant, run in-context.
  console.log('\n📊 Per-tenant user counts:');
  for (const t of TENANTS) {
    const tenant = await Tenant.findOne({ slug: t.slug })
      .setOptions({ skipTenantScope: true })
      .lean();
    await runWithTenant(tenant, async () => {
      const count = await User.countDocuments();
      console.log(`   ${t.slug.padEnd(10)} → ${count} users`);
    });
  }

  console.log('\n🔑 Seed login password for ALL accounts: ' + SEED_PASSWORD);
  console.log('   Example: acme.app.local → alice@acme.test / ' + SEED_PASSWORD);

  await disconnectDb();
  console.log('\n✨ Seed complete.');
}

run().catch(async (err) => {
  console.error('Seed failed:', err);
  await disconnectDb().catch(() => {});
  process.exit(1);
});

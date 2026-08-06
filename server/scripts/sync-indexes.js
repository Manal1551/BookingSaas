/**
 * Reconcile the database's indexes with what the Mongoose schemas declare.
 *
 * Mongoose builds *missing* indexes automatically, but it never DROPS indexes
 * that a schema stopped declaring — so when a field is removed or an index is
 * redefined (as happened when Week 2 moved idempotency out of the Booking
 * document into its own collection), the obsolete index lingers on the
 * collection and can still enforce constraints the code no longer intends.
 *
 * A concrete symptom: a leftover UNIQUE `{ tenantId, idempotencyKey }` index on
 * `bookings` rejected concurrent inserts (all now `idempotencyKey: null`) with
 * E11000, surfacing as 500s under load.
 *
 * `model.syncIndexes()` fixes this: it creates missing indexes and drops any
 * that are not in the current schema. It is safe to run repeatedly and is a
 * no-op once the database already matches. Run it after any index/schema
 * change, and as a one-off to clean an older database.
 *
 * Run: npm run sync:indexes   (from repo root)  or  node scripts/sync-indexes.js
 */
import { connectDb, disconnectDb } from '../src/config/db.js';
import { Booking } from '../src/models/Booking.js';
import { IdempotencyKey } from '../src/models/IdempotencyKey.js';
import { User } from '../src/models/User.js';
import { Tenant } from '../src/models/Tenant.js';
import { Subscription } from '../src/models/Subscription.js';
import { Invoice } from '../src/models/Invoice.js';
import { WebhookEvent } from '../src/models/WebhookEvent.js';

const MODELS = [
  Booking,
  IdempotencyKey,
  User,
  Tenant,
  // Week 3 billing. Tenant also gains a sparse-unique `stripeCustomerId` index,
  // which this run creates on an existing database.
  Subscription,
  Invoice,
  WebhookEvent,
];

async function run() {
  await connectDb();

  for (const Model of MODELS) {
    const before = (await Model.collection.indexes()).map((i) => i.name);
    // syncIndexes returns the names of indexes it DROPPED.
    const dropped = await Model.syncIndexes();
    const after = (await Model.collection.indexes()).map((i) => i.name);

    console.log(`\n📕 ${Model.modelName} (${Model.collection.collectionName})`);
    console.log(`   before: ${before.join(', ')}`);
    if (dropped.length) {
      console.log(`   ❌ dropped: ${dropped.join(', ')}`);
    } else {
      console.log('   ✓ nothing to drop');
    }
    console.log(`   after:  ${after.join(', ')}`);
  }

  await disconnectDb();
  console.log('\n✨ Indexes synced.');
}

run().catch(async (err) => {
  console.error('sync-indexes failed:', err);
  await disconnectDb().catch(() => {});
  process.exit(1);
});

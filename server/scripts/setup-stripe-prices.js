/**
 * Creates the Stripe Products and Prices this app's catalog expects, then
 * prints the env block to paste into server/.env.
 *
 * Creating four prices by hand in the dashboard is six forms and four chances
 * to mistype an id, so this does it from the catalog itself — which also means
 * the amounts in Stripe cannot drift from the amounts in `config/plans.js`.
 *
 * SAFE TO RE-RUN. Each product is looked up by a stable `metadata.planId`
 * before anything is created, and a price is only added if no active price
 * with the same amount + interval already exists. Re-running prints the same
 * ids rather than creating duplicates.
 *
 * It never deletes or modifies anything, and it refuses to run against a live
 * key — this is a development helper.
 *
 * Run:  node scripts/setup-stripe-prices.js     (from server/)
 */
import { env } from '../src/config/env.js';
import { PLANS, CURRENCY } from '../src/config/plans.js';
import { getStripe, isBillingConfigured } from '../src/services/stripe.js';

const INTERVALS = { monthly: 'month', yearly: 'year' };

/** Plans that are actually sold — Free has nothing to create. */
const PAID_PLANS = Object.values(PLANS).filter((p) => p.id !== 'free');

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/** Finds this plan's product by metadata, or creates it. */
async function ensureProduct(stripe, plan) {
  // `search` is eventually consistent on very new objects, so fall back to a
  // list scan — a handful of products at most in a dev account.
  const { data: products } = await stripe.products.list({ limit: 100, active: true });
  const existing = products.find((p) => p.metadata?.planId === plan.id);

  if (existing) {
    console.log(`   ↺ product exists: ${existing.name} (${existing.id})`);
    return existing;
  }

  const created = await stripe.products.create({
    name: `${plan.name}`,
    description: plan.tagline,
    metadata: { planId: plan.id, managedBy: 'booking-saas' },
  });
  console.log(`   ✚ created product: ${created.name} (${created.id})`);
  return created;
}

/** Finds a matching recurring price on the product, or creates it. */
async function ensurePrice(stripe, product, plan, interval) {
  const amount = plan.prices[interval].amount;
  const recurring = INTERVALS[interval];

  const { data: prices } = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });

  const existing = prices.find(
    (p) =>
      p.unit_amount === amount &&
      p.currency === CURRENCY &&
      p.recurring?.interval === recurring
  );

  if (existing) {
    console.log(`   ↺ ${interval} price exists: ${existing.id}`);
    return existing;
  }

  const created = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency: CURRENCY,
    recurring: { interval: recurring },
    metadata: { planId: plan.id, interval, managedBy: 'booking-saas' },
  });
  console.log(`   ✚ created ${interval} price: ${created.id}`);
  return created;
}

async function run() {
  if (!isBillingConfigured()) {
    fail(
      'STRIPE_SECRET_KEY is not set in server/.env.\n' +
        '   Get a TEST key from https://dashboard.stripe.com/test/apikeys first.'
    );
  }

  if (env.STRIPE_SECRET_KEY.startsWith('sk_live')) {
    fail(
      'That is a LIVE key. This script is a development helper and refuses to\n' +
        '   create products in a live account. Use a sk_test_... key.'
    );
  }

  const stripe = getStripe();

  // Verify the key before doing anything, so a typo fails on line one rather
  // than half way through creating products.
  try {
    const account = await stripe.accounts.retrieve();
    console.log(`\n🔑 Connected to Stripe account: ${account.id}`);
  } catch (err) {
    fail(`Could not authenticate with Stripe: ${err?.message}`);
  }

  const envLines = [];

  for (const plan of PAID_PLANS) {
    console.log(`\n📦 ${plan.name}`);
    const product = await ensureProduct(stripe, plan);

    for (const interval of Object.keys(INTERVALS)) {
      const price = await ensurePrice(stripe, product, plan, interval);
      envLines.push(
        `STRIPE_PRICE_${plan.id.toUpperCase()}_${interval.toUpperCase()}=${price.id}`
      );
    }
  }

  console.log('\n' + '─'.repeat(64));
  console.log('Paste these into server/.env (replacing the blank lines):\n');
  console.log(envLines.join('\n'));
  console.log('\n' + '─'.repeat(64));
  console.log(
    '\nThen restart the server. Checkout will work immediately.\n' +
      'Webhooks are separate — see server/docs/BILLING.md §8.\n'
  );
}

run().catch((err) => {
  console.error('\nsetup-stripe-prices failed:', err?.message ?? err);
  process.exit(1);
});

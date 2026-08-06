import { env } from '../config/env.js';
import { Tenant } from '../models/Tenant.js';
import { Subscription, isEntitled } from '../models/Subscription.js';
import { AppError } from '../utils/appError.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { priceIdFor, getPlan, comparePlans } from '../config/plans.js';
import { getStripe, toBillingError, fromStripeTimestamp } from './stripe.js';
import { applySubscription, priceIdOfSubscription } from './billingSync.js';

/**
 * The write side of billing: everything the dashboard can *ask* Stripe to do.
 *
 * Rule of the module: it asks Stripe to change something and then lets the
 * webhook be the thing that records it. Where a response already contains the
 * updated subscription (plan changes, cancel, resume) we also apply it eagerly
 * so the UI updates on the same round-trip — but that is an optimisation, not
 * the source of truth. Dropping every eager write would still leave the system
 * correct, just slower to reflect.
 */

/** Substitutes the tenant's subdomain into the configured return URL. */
function returnUrl(tenant, params = {}) {
  const base = env.BILLING_RETURN_URL.replaceAll('{slug}', tenant.slug);
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Returns the tenant's Stripe Customer id, creating the customer on first use.
 *
 * Created lazily rather than at signup so tenants that never open billing
 * leave no footprint in Stripe. `metadata.tenantId` is stamped here and is
 * what lets a webhook find its way home when the local link is missing.
 */
export async function ensureCustomer(tenant, { email, name } = {}) {
  if (tenant.stripeCustomerId) return tenant.stripeCustomerId;

  const stripe = getStripe();
  const customer = await stripe.customers.create(
    {
      name: tenant.name,
      email: email || undefined,
      metadata: {
        tenantId: String(tenant._id),
        tenantSlug: tenant.slug,
        createdBy: name || 'unknown',
      },
    },
    // Keyed on the tenant, so a double-clicked "Upgrade" cannot create two
    // customers for the same workspace.
    { idempotencyKey: `tenant-customer-${tenant._id}` }
  );

  await Tenant.updateOne(
    { _id: tenant._id },
    { $set: { stripeCustomerId: customer.id } }
  );

  return customer.id;
}

/** The tenant's current subscription row, or null. Newest first. */
export async function currentSubscription(tenant) {
  // Awaited inside the context on purpose — see the note in billingSync.js.
  const rows = await runWithTenant(tenant, async () => {
    const found = await Subscription.find({}).sort({ createdAt: -1 }).lean();
    return found;
  });
  // An entitled subscription is "the" subscription; otherwise show the most
  // recent one so a canceled or past_due state is still visible in the UI.
  return rows.find((s) => isEntitled(s)) ?? rows[0] ?? null;
}

function resolvePrice(planId, interval) {
  const plan = getPlan(planId);
  if (!plan) {
    throw new AppError('VALIDATION_ERROR', `Unknown plan "${planId}".`, [
      { path: 'body.planId', message: 'Not a known plan' },
    ]);
  }
  if (planId === 'free') {
    throw new AppError(
      'VALIDATION_ERROR',
      'The Free plan has nothing to check out. Cancel your subscription to move down to Free.',
      [{ path: 'body.planId', message: 'Free is not a purchasable plan' }]
    );
  }
  const priceId = priceIdFor(planId, interval);
  if (!priceId) {
    throw new AppError(
      'PLAN_UNAVAILABLE',
      `The ${plan.name} plan is not available for ${interval} billing on this deployment.`
    );
  }
  return priceId;
}

/**
 * Creates a Stripe Checkout Session for a NEW subscription.
 *
 * Checkout (rather than a bespoke card form) is deliberate: card details never
 * touch this server, which keeps the PCI surface at SAQ-A and puts 3-D Secure,
 * wallets, and tax handling on Stripe's side.
 *
 * @param {object} args
 * @param {object} args.tenant
 * @param {object} args.user     the requesting user (for the receipt email)
 * @param {string} args.planId
 * @param {'monthly'|'yearly'} args.interval
 * @param {string} [args.idempotencyKey] forwarded to Stripe
 */
export async function createCheckoutSession({
  tenant,
  user,
  planId,
  interval,
  idempotencyKey,
}) {
  const priceId = resolvePrice(planId, interval);

  // Switching plans while already subscribed must go through the update path —
  // a second Checkout would leave the tenant paying for two subscriptions.
  const existing = await currentSubscription(tenant);
  if (existing && isEntitled(existing)) {
    throw new AppError(
      'PLAN_UNCHANGED',
      'This workspace already has an active subscription. Change your plan instead of starting a new one.'
    );
  }

  try {
    const stripe = getStripe();
    const customerId = await ensureCustomer(tenant, {
      email: user?.email,
      name: user?.name,
    });

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        // `{CHECKOUT_SESSION_ID}` is substituted by Stripe on redirect, giving
        // the client a handle to confirm against while webhooks land.
        success_url: returnUrl(tenant, {
          checkout: 'success',
          session_id: '{CHECKOUT_SESSION_ID}',
        }).replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}'),
        cancel_url: returnUrl(tenant, { checkout: 'cancelled' }),
        client_reference_id: String(tenant._id),
        // Stamped on BOTH the session and the subscription it creates: the
        // session metadata identifies the tenant for checkout.* events, the
        // subscription_data metadata for every later customer.subscription.*.
        metadata: {
          tenantId: String(tenant._id),
          tenantSlug: tenant.slug,
          planId,
          interval,
        },
        subscription_data: {
          metadata: {
            tenantId: String(tenant._id),
            tenantSlug: tenant.slug,
            planId,
            interval,
          },
        },
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
      },
      idempotencyKey ? { idempotencyKey } : undefined
    );

    return { id: session.id, url: session.url, expiresAt: fromStripeTimestamp(session.expires_at) };
  } catch (err) {
    throw toBillingError(err);
  }
}

/**
 * Creates a Billing Portal session — Stripe's hosted surface for updating a
 * card, downloading invoices, and managing the subscription. Cheaper and safer
 * than rebuilding payment-method management ourselves.
 */
export async function createPortalSession({ tenant }) {
  if (!tenant.stripeCustomerId) {
    throw new AppError(
      'NO_SUBSCRIPTION',
      'This workspace has no billing history yet. Choose a plan first.'
    );
  }
  try {
    const stripe = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: returnUrl(tenant, { portal: 'return' }),
    });
    return { url: session.url };
  } catch (err) {
    throw toBillingError(err);
  }
}

/** Loads the live Stripe subscription behind a local row. */
async function fetchStripeSubscription(local) {
  const stripe = getStripe();
  return stripe.subscriptions.retrieve(local.stripeSubscriptionId, {
    expand: ['items.data.price'],
  });
}

/**
 * Previews what switching plans would cost *right now*.
 *
 * Shown before the user confirms, because mid-cycle proration is the single
 * most surprising thing about subscription billing: an upgrade usually charges
 * a prorated amount immediately, a downgrade usually leaves a credit. Quoting
 * Stripe's own arithmetic avoids us guessing at it.
 */
export async function previewPlanChange({ tenant, planId, interval }) {
  const priceId = resolvePrice(planId, interval);
  const local = await currentSubscription(tenant);

  if (!local || !isEntitled(local)) {
    throw new AppError(
      'NO_SUBSCRIPTION',
      'There is no active subscription to change. Start one from the plans page.'
    );
  }
  if (local.stripePriceId === priceId) {
    throw new AppError('PLAN_UNCHANGED', 'This workspace is already on that plan.');
  }

  try {
    const stripe = getStripe();
    const subscription = await fetchStripeSubscription(local);
    const itemId = subscription.items.data[0]?.id;

    const preview = await stripe.invoices.createPreview({
      customer: tenant.stripeCustomerId,
      subscription: subscription.id,
      subscription_details: {
        items: [{ id: itemId, price: priceId }],
        proration_behavior: 'create_prorations',
      },
    });

    const direction = comparePlans(planId, local.planId) >= 0 ? 'upgrade' : 'downgrade';

    return {
      direction,
      from: { planId: local.planId, interval: local.interval },
      to: { planId, interval },
      currency: preview.currency,
      // What lands on the card at confirmation time. Negative totals become a
      // credit against the next invoice rather than a refund — say so plainly.
      amountDueNow: Math.max(0, preview.amount_due ?? 0),
      prorationTotal: preview.total ?? 0,
      nextBillingAt: local.currentPeriodEnd,
      lines: (preview.lines?.data ?? []).slice(0, 10).map((line) => ({
        description: line.description,
        amount: line.amount,
        proration: Boolean(line.parent?.subscription_item_details?.proration ?? line.proration),
      })),
    };
  } catch (err) {
    throw toBillingError(err);
  }
}

/**
 * Applies an upgrade or downgrade to the existing subscription.
 *
 * Proration behaviour differs by direction on purpose:
 *  - UPGRADE   -> `always_invoice`: the customer gets the bigger plan now and
 *                 is charged the prorated difference immediately.
 *  - DOWNGRADE -> `create_prorations`: they keep what they paid for until the
 *                 period ends, and the credit offsets the next invoice. This
 *                 avoids issuing refunds for a plan they are still using.
 */
export async function changePlan({ tenant, planId, interval }) {
  const priceId = resolvePrice(planId, interval);
  const local = await currentSubscription(tenant);

  if (!local || !isEntitled(local)) {
    throw new AppError(
      'NO_SUBSCRIPTION',
      'There is no active subscription to change. Start one from the plans page.'
    );
  }
  if (local.stripePriceId === priceId) {
    throw new AppError('PLAN_UNCHANGED', 'This workspace is already on that plan.');
  }

  const direction = comparePlans(planId, local.planId) >= 0 ? 'upgrade' : 'downgrade';

  try {
    const stripe = getStripe();
    const subscription = await fetchStripeSubscription(local);
    const itemId = subscription.items.data[0]?.id;

    const updated = await stripe.subscriptions.update(local.stripeSubscriptionId, {
      items: [{ id: itemId, price: priceId }],
      proration_behavior: direction === 'upgrade' ? 'always_invoice' : 'create_prorations',
      // A pending cancellation is meaningless once they pick a new plan.
      cancel_at_period_end: false,
      payment_behavior: 'error_if_incomplete',
      metadata: {
        ...(subscription.metadata ?? {}),
        tenantId: String(tenant._id),
        planId,
        interval,
      },
      expand: ['items.data.price'],
    });

    // Eager apply so the response already carries the new plan. The matching
    // customer.subscription.updated webhook will arrive moments later and be a
    // no-op thanks to the ordering guard.
    await applySubscription({
      tenant,
      subscription: updated,
      eventAt: new Date(),
      eventId: 'plan-change',
    });

    return {
      direction,
      planId,
      interval,
      status: updated.status,
      priceId: priceIdOfSubscription(updated),
    };
  } catch (err) {
    throw toBillingError(err);
  }
}

/**
 * Schedules cancellation for the end of the paid period.
 *
 * Never immediate: the tenant paid through the period end and should keep the
 * plan until then. `Tenant.plan` therefore stays put — only `cancelAtPeriodEnd`
 * flips, and the drop to `free` happens when Stripe sends
 * `customer.subscription.deleted` at period end.
 */
export async function cancelSubscription({ tenant }) {
  const local = await currentSubscription(tenant);
  if (!local || !isEntitled(local)) {
    throw new AppError('NO_SUBSCRIPTION', 'There is no active subscription to cancel.');
  }

  try {
    const stripe = getStripe();
    const updated = await stripe.subscriptions.update(local.stripeSubscriptionId, {
      cancel_at_period_end: true,
      expand: ['items.data.price'],
    });

    await applySubscription({
      tenant,
      subscription: updated,
      eventAt: new Date(),
      eventId: 'cancel',
    });

    return {
      cancelAtPeriodEnd: true,
      accessUntil: local.currentPeriodEnd,
    };
  } catch (err) {
    throw toBillingError(err);
  }
}

/** Undoes a scheduled cancellation, while the period is still running. */
export async function resumeSubscription({ tenant }) {
  const local = await currentSubscription(tenant);
  if (!local) {
    throw new AppError('NO_SUBSCRIPTION', 'There is no subscription to resume.');
  }
  if (!local.cancelAtPeriodEnd) {
    throw new AppError(
      'PLAN_UNCHANGED',
      'This subscription is not scheduled to cancel.'
    );
  }

  try {
    const stripe = getStripe();
    const updated = await stripe.subscriptions.update(local.stripeSubscriptionId, {
      cancel_at_period_end: false,
      expand: ['items.data.price'],
    });

    await applySubscription({
      tenant,
      subscription: updated,
      eventAt: new Date(),
      eventId: 'resume',
    });

    return { cancelAtPeriodEnd: false, status: updated.status };
  } catch (err) {
    throw toBillingError(err);
  }
}

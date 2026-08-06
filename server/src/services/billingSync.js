import { Tenant } from '../models/Tenant.js';
import { Subscription, isEntitled } from '../models/Subscription.js';
import { Invoice } from '../models/Invoice.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { isDuplicateKeyError } from '../utils/appError.js';
import { planForPriceId } from '../config/plans.js';
import { getStripe, fromStripeTimestamp, idOf } from './stripe.js';

/**
 * Projection of Stripe objects onto the local mirror.
 *
 * This module is the ONLY place that writes Subscription, Invoice, or
 * `Tenant.plan`. Both the webhook pipeline and the "reconcile now" fallback go
 * through it, so a state transition means exactly the same thing however it
 * arrived — which is what makes the webhook safe to replay and the fallback
 * safe to run at any time.
 *
 * Two invariants every writer here upholds:
 *
 *  1. TENANT CONTEXT. Subscription and Invoice carry the tenant-scope plugin,
 *     which fails closed without a tenant in AsyncLocalStorage. A webhook has
 *     no subdomain to resolve, so callers re-enter a context explicitly via
 *     `runWithTenant`. The isolation guarantee is preserved, not bypassed.
 *
 *  2. ORDERING. Stripe does not promise ordered delivery. Each write is
 *     conditional on `lastEventAt <= incoming event time`, so an older event
 *     overtaking a newer one is dropped instead of resurrecting a stale plan.
 */

/**
 * Stripe moved the period window from the subscription onto its items in the
 * 2025-03-31 API version. Read the item first and fall back, so the mirror is
 * correct on either version.
 */
function periodWindow(subscription) {
  const item = subscription.items?.data?.[0];
  return {
    currentPeriodStart: fromStripeTimestamp(
      item?.current_period_start ?? subscription.current_period_start
    ),
    currentPeriodEnd: fromStripeTimestamp(
      item?.current_period_end ?? subscription.current_period_end
    ),
  };
}

/** The subscription's active price — `subscription.plan` is long deprecated. */
export function priceIdOfSubscription(subscription) {
  return idOf(subscription.items?.data?.[0]?.price) ?? null;
}

/**
 * `invoice.subscription` became `invoice.parent.subscription_details` in
 * recent API versions. Same fallback treatment.
 */
function invoiceSubscriptionId(invoice) {
  return (
    idOf(invoice.parent?.subscription_details?.subscription) ??
    idOf(invoice.subscription) ??
    null
  );
}

/**
 * Finds the tenant an incoming Stripe object belongs to.
 *
 * Preference order matters. The local `stripeCustomerId` link is checked first
 * because it is the mapping *we* created and cannot be edited from the Stripe
 * dashboard. `metadata.tenantId` — which we stamp on every customer,
 * subscription and checkout session — is the fallback that covers the window
 * before the link is saved. Only then do we spend a network call.
 *
 * Returns null for objects belonging to no tenant (e.g. a customer created by
 * hand in the Stripe dashboard); the caller acknowledges those rather than
 * failing, so Stripe does not retry them forever.
 */
export async function resolveTenant({ customerId, metadata }) {
  if (customerId) {
    const byLink = await Tenant.findOne({ stripeCustomerId: customerId }).lean();
    if (byLink) return byLink;
  }

  const metaTenantId = metadata?.tenantId;
  if (metaTenantId) {
    const byMeta = await Tenant.findById(metaTenantId).lean();
    if (byMeta) return byMeta;
  }

  if (customerId) {
    // Last resort: ask Stripe for the customer's metadata. Reaches this only
    // for an object whose local link was lost — worth one call to recover.
    try {
      const customer = await getStripe().customers.retrieve(customerId);
      const tenantId = customer?.deleted ? null : customer?.metadata?.tenantId;
      if (tenantId) {
        const byRemote = await Tenant.findById(tenantId).lean();
        if (byRemote) return byRemote;
      }
    } catch {
      // Fall through to "unknown tenant" — the caller will acknowledge and log.
    }
  }

  return null;
}

/** The plan a tenant is entitled to, given the state of its subscription. */
export function effectivePlan(subscription) {
  if (!subscription) return 'free';
  return isEntitled(subscription) ? subscription.planId : 'free';
}

/**
 * Upserts the local mirror of one Stripe Subscription and re-derives
 * `Tenant.plan` from it.
 *
 * @param {object} args
 * @param {object} args.tenant       tenant document (lean)
 * @param {object} args.subscription Stripe Subscription object
 * @param {Date}   args.eventAt      `created` time of the event carrying it
 * @param {string} [args.eventId]
 * @returns {Promise<{ applied: boolean, reason?: string, planId?: string }>}
 */
export async function applySubscription({ tenant, subscription, eventAt, eventId }) {
  const priceId = priceIdOfSubscription(subscription);
  const mapped = planForPriceId(priceId);

  if (!mapped) {
    // A price this deployment does not know about — someone subscribed the
    // customer to a product outside our catalog. Recording a guess would put
    // the tenant on the wrong plan, so refuse rather than mis-entitle.
    return { applied: false, reason: `unknown-price:${priceId ?? 'none'}` };
  }

  const { currentPeriodStart, currentPeriodEnd } = periodWindow(subscription);

  const fields = {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: idOf(subscription.customer),
    stripePriceId: priceId,
    planId: mapped.planId,
    interval: mapped.interval,
    status: subscription.status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
    canceledAt: fromStripeTimestamp(subscription.canceled_at),
    trialEndsAt: fromStripeTimestamp(subscription.trial_end),
    lastEventAt: eventAt,
    lastEventId: eventId ?? null,
    syncedAt: new Date(),
  };

  const applied = await runWithTenant(tenant, async () => {
    try {
      // The ordering guard lives in the FILTER, so the check and the write are
      // one atomic operation. If a newer event already landed, the filter
      // misses, the upsert attempts an insert, and the unique index rejects it
      // — which is exactly the signal that this event is stale.
      await Subscription.updateOne(
        {
          stripeSubscriptionId: subscription.id,
          $or: [{ lastEventAt: null }, { lastEventAt: { $lte: eventAt } }],
        },
        { $set: fields },
        { upsert: true }
      );
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false; // superseded by a newer event
      throw err;
    }
  });

  if (!applied) return { applied: false, reason: 'stale-event' };

  await syncTenantPlan(tenant._id);
  return { applied: true, planId: mapped.planId };
}

/**
 * Recomputes the tenant's denormalised `plan` from its subscriptions.
 *
 * Derived from the stored rows rather than from the event in hand, so the
 * answer is the same no matter which event triggered it — and so a tenant with
 * an old canceled subscription plus a new active one lands on the active one.
 */
export async function syncTenantPlan(tenantId) {
  const tenant = await Tenant.findById(tenantId).lean();
  if (!tenant) return null;

  // NOTE the `await` INSIDE the callback. A Mongoose query is lazy — returning
  // the unexecuted Query from `runWithTenant` would let it run after the async
  // context has already exited, and the scope plugin (correctly) refuses to
  // run without a tenant. Every tenant-scoped query in this file is awaited
  // inside its context for that reason.
  // NOTE the `await` INSIDE the callback. A Mongoose query is lazy — returning
  // the unexecuted Query from `runWithTenant` would let it run after the async
  // context has already exited, and the scope plugin (correctly) refuses to
  // run without a tenant. Every tenant-scoped query in this file awaits inside
  // its context for that reason.
  const subscriptions = await runWithTenant(tenant, async () => {
    const rows = await Subscription.find({}).sort({ createdAt: -1 }).lean();
    return rows;
  });

  // An entitled subscription wins over any number of dead ones.
  const live = subscriptions.find((s) => isEntitled(s));
  const plan = effectivePlan(live);

  if (tenant.plan !== plan) {
    await Tenant.updateOne({ _id: tenantId }, { $set: { plan } });
  }
  return plan;
}

/** Upserts the local mirror of one Stripe Invoice. */
export async function applyInvoice({ tenant, invoice, eventAt }) {
  const subscriptionId = invoiceSubscriptionId(invoice);
  const priceId = idOf(invoice.lines?.data?.[0]?.pricing?.price_details?.price)
    ?? idOf(invoice.lines?.data?.[0]?.price);
  const mapped = planForPriceId(priceId);

  const fields = {
    stripeInvoiceId: invoice.id,
    stripeCustomerId: idOf(invoice.customer),
    stripeSubscriptionId: subscriptionId,
    number: invoice.number ?? null,
    status: invoice.status,
    amountDue: invoice.amount_due ?? 0,
    amountPaid: invoice.amount_paid ?? 0,
    amountRemaining: invoice.amount_remaining ?? 0,
    currency: invoice.currency ?? 'usd',
    planId: mapped?.planId ?? null,
    description:
      invoice.description ?? invoice.lines?.data?.[0]?.description ?? null,
    periodStart: fromStripeTimestamp(invoice.period_start),
    periodEnd: fromStripeTimestamp(invoice.period_end),
    issuedAt:
      fromStripeTimestamp(invoice.status_transitions?.finalized_at) ??
      fromStripeTimestamp(invoice.created),
    paidAt: fromStripeTimestamp(invoice.status_transitions?.paid_at),
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    lastEventAt: eventAt,
  };

  const applied = await runWithTenant(tenant, async () => {
    try {
      await Invoice.updateOne(
        {
          stripeInvoiceId: invoice.id,
          $or: [{ lastEventAt: null }, { lastEventAt: { $lte: eventAt } }],
        },
        { $set: fields },
        { upsert: true }
      );
      return true;
    } catch (err) {
      if (isDuplicateKeyError(err)) return false;
      throw err;
    }
  });

  if (!applied) return { applied: false, reason: 'stale-event' };

  // Surface the payment outcome on the subscription so the billing page can
  // warn about a failed charge without joining across collections.
  if (subscriptionId) {
    await runWithTenant(tenant, async () => {
      await Subscription.updateOne(
        { stripeSubscriptionId: subscriptionId },
        { $set: { latestInvoiceStatus: invoice.status } }
      );
    });
  }

  return { applied: true, status: invoice.status };
}

/**
 * Pulls a tenant's billing state straight from Stripe and re-applies it.
 *
 * The safety net for the two cases webhooks cannot cover: local development
 * with no tunnel to receive them, and the rare event that was dropped or
 * failed every retry. Because it funnels into the same `apply*` writers, it
 * can be called at any time without risk of a different outcome.
 */
export async function reconcileTenant(tenant) {
  if (!tenant?.stripeCustomerId) return { reconciled: false, reason: 'no-customer' };

  const stripe = getStripe();
  const now = new Date();

  const { data: subscriptions } = await stripe.subscriptions.list({
    customer: tenant.stripeCustomerId,
    status: 'all',
    limit: 10,
  });

  for (const subscription of subscriptions) {
    await applySubscription({
      tenant,
      subscription,
      // Stamp with "now": a manual reconcile reflects the live truth and should
      // win over any event still in flight.
      eventAt: now,
      eventId: 'reconcile',
    });
  }

  const { data: invoices } = await stripe.invoices.list({
    customer: tenant.stripeCustomerId,
    limit: 50,
  });

  for (const invoice of invoices) {
    await applyInvoice({ tenant, invoice, eventAt: now });
  }

  const plan = await syncTenantPlan(tenant._id);
  return {
    reconciled: true,
    plan,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
  };
}

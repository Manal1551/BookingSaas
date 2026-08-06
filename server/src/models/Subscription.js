import mongoose from 'mongoose';
import { tenantScopePlugin } from '../middleware/tenantScopePlugin.js';
import { PLAN_IDS, BILLING_INTERVALS } from '../config/plans.js';

/**
 * The local mirror of a Stripe Subscription.
 *
 * Stripe is authoritative; this collection exists so that reading "what plan
 * is this tenant on, and is it in good standing?" is a single indexed local
 * query on the request path instead of a network call to Stripe. It is written
 * exclusively by the webhook pipeline (plus one optimistic write when checkout
 * starts), never by the UI.
 *
 * It is tenant-scoped like everything else a logged-in user can read, so the
 * dashboard cannot query another tenant's billing state even by accident. The
 * webhook handler has no subdomain to resolve a tenant from, so it re-enters a
 * tenant context explicitly (see services/billingSync.js) before writing.
 */

/** Stripe's subscription lifecycle, mirrored verbatim. */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
]);

/** Statuses that should unlock paid features. */
export const ENTITLED_STATUSES = Object.freeze(['trialing', 'active', 'past_due']);

export const SUBSCRIPTION_STRIPE_ID_INDEX = 'subscription_stripe_id_unique';

const subscriptionSchema = new mongoose.Schema(
  {
    // tenantId comes from tenantScopePlugin.
    stripeSubscriptionId: { type: String, required: true, trim: true },
    stripeCustomerId: { type: String, required: true, trim: true },
    stripePriceId: { type: String, default: null },

    planId: { type: String, enum: PLAN_IDS, required: true },
    interval: { type: String, enum: BILLING_INTERVALS, default: 'monthly' },
    status: { type: String, enum: SUBSCRIPTION_STATUSES, required: true },

    currentPeriodStart: { type: Date, default: null },
    currentPeriodEnd: { type: Date, default: null },
    cancelAtPeriodEnd: { type: Boolean, default: false },
    canceledAt: { type: Date, default: null },
    trialEndsAt: { type: Date, default: null },

    // Denormalised from the latest invoice so the billing page can warn about a
    // failed payment without joining.
    latestInvoiceStatus: { type: String, default: null },

    /**
     * `created` timestamp of the most recent Stripe event applied to this row.
     *
     * Stripe explicitly does not guarantee delivery order: a rapid
     * upgrade-then-downgrade can arrive reversed, which would otherwise leave
     * the tenant permanently on the wrong plan. Every writer compares against
     * this and drops anything older. This is the ordering guard.
     */
    lastEventAt: { type: Date, default: null },
    lastEventId: { type: String, default: null },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'subscriptions' }
);

// One row per Stripe subscription. Scoped by tenant so the id is unique within
// a tenant; the Stripe id is globally unique anyway, which makes this a safe
// upsert target for the webhook.
subscriptionSchema.index(
  { tenantId: 1, stripeSubscriptionId: 1 },
  { unique: true, name: SUBSCRIPTION_STRIPE_ID_INDEX }
);
// The dashboard's hot query: "this tenant's most recent subscription".
subscriptionSchema.index({ tenantId: 1, createdAt: -1 });

subscriptionSchema.plugin(tenantScopePlugin);

/** True when this subscription should unlock its plan's paid features. */
export function isEntitled(subscription) {
  return Boolean(subscription) && ENTITLED_STATUSES.includes(subscription.status);
}

export const Subscription =
  mongoose.models.Subscription ||
  mongoose.model('Subscription', subscriptionSchema);

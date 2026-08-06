import { env } from './env.js';

/**
 * The pricing catalog — the single source of truth for what a plan *is*.
 *
 * Everything downstream reads from here: the pricing page, the checkout
 * session, the webhook that maps a Stripe price back onto a plan, and the
 * entitlement checks. Amounts live here rather than being read back from
 * Stripe so the pricing page renders instantly (and correctly) even when the
 * Stripe API is slow or unconfigured — Stripe remains authoritative for what
 * is actually *charged*, which is why the price IDs come from the environment.
 *
 * `free` and `pro` are the two plan ids Week 1 already stored on Tenant; they
 * keep their exact meaning. `business` is added above them.
 */

/** @typedef {'free'|'pro'|'business'} PlanId */
/** @typedef {'monthly'|'yearly'} BillingInterval */

export const PLAN_IDS = Object.freeze(['free', 'pro', 'business']);
export const BILLING_INTERVALS = Object.freeze(['monthly', 'yearly']);

/** Ranking used to tell an upgrade from a downgrade (drives proration UX). */
const PLAN_RANK = Object.freeze({ free: 0, pro: 1, business: 2 });

export const PLANS = Object.freeze({
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Everything you need to take your first bookings.',
    prices: { monthly: { amount: 0, priceId: null }, yearly: { amount: 0, priceId: null } },
    limits: { bookingsPerMonth: 50, teamMembers: 2, resources: 1 },
    features: [
      'Up to 50 bookings per month',
      '2 team members',
      '1 bookable resource',
      'Calendar & list views',
      'Email support',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'For growing teams that book all day, every day.',
    prices: {
      monthly: { amount: 2900, priceId: env.STRIPE_PRICE_PRO_MONTHLY ?? null },
      yearly: { amount: 29000, priceId: env.STRIPE_PRICE_PRO_YEARLY ?? null },
    },
    limits: { bookingsPerMonth: 2000, teamMembers: 15, resources: 25 },
    features: [
      'Up to 2,000 bookings per month',
      '15 team members',
      '25 bookable resources',
      'Conflict-free double-booking guard',
      'Priority email support',
    ],
    popular: true,
  },
  business: {
    id: 'business',
    name: 'Business',
    tagline: 'Unlimited scale, with the controls a bigger team needs.',
    prices: {
      monthly: { amount: 9900, priceId: env.STRIPE_PRICE_BUSINESS_MONTHLY ?? null },
      yearly: { amount: 99000, priceId: env.STRIPE_PRICE_BUSINESS_YEARLY ?? null },
    },
    limits: { bookingsPerMonth: Infinity, teamMembers: Infinity, resources: Infinity },
    features: [
      'Unlimited bookings',
      'Unlimited team members',
      'Unlimited resources',
      'Role-based access control',
      'Dedicated support & onboarding',
    ],
  },
});

/** The currency every price in the catalog is quoted in. */
export const CURRENCY = 'usd';

export function isPlanId(value) {
  return PLAN_IDS.includes(value);
}

export function getPlan(planId) {
  return PLANS[planId] ?? null;
}

/** Positive when `a` is a higher tier than `b`. */
export function comparePlans(a, b) {
  return (PLAN_RANK[a] ?? -1) - (PLAN_RANK[b] ?? -1);
}

/**
 * Reverse lookup: Stripe tells us a price ID, we need the plan it belongs to.
 * Used by the subscription webhooks, which receive prices and nothing else.
 *
 * @returns {{ planId: PlanId, interval: BillingInterval } | null}
 */
export function planForPriceId(priceId) {
  if (!priceId) return null;
  for (const plan of Object.values(PLANS)) {
    for (const interval of BILLING_INTERVALS) {
      if (plan.prices[interval].priceId === priceId) {
        return { planId: plan.id, interval };
      }
    }
  }
  return null;
}

/** Forward lookup used when starting a checkout or switching plans. */
export function priceIdFor(planId, interval) {
  return PLANS[planId]?.prices?.[interval]?.priceId ?? null;
}

/**
 * Wire format for the pricing page. `Infinity` is not representable in JSON,
 * so unlimited limits travel as `null` and the UI renders them as "Unlimited".
 * `available` tells the client whether a Checkout can actually be started —
 * a paid plan with no configured price ID renders as "contact us" instead of a
 * button that would fail.
 */
export function serializePlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    tagline: plan.tagline,
    popular: Boolean(plan.popular),
    currency: CURRENCY,
    prices: {
      monthly: {
        amount: plan.prices.monthly.amount,
        available: plan.id === 'free' || Boolean(plan.prices.monthly.priceId),
      },
      yearly: {
        amount: plan.prices.yearly.amount,
        available: plan.id === 'free' || Boolean(plan.prices.yearly.priceId),
      },
    },
    limits: Object.fromEntries(
      Object.entries(plan.limits).map(([k, v]) => [k, Number.isFinite(v) ? v : null])
    ),
    features: plan.features,
  };
}

export function serializeCatalog() {
  return PLAN_IDS.map((id) => serializePlan(PLANS[id]));
}

import { Tenant } from '../models/Tenant.js';
import { User } from '../models/User.js';
import { Invoice } from '../models/Invoice.js';
import { isEntitled } from '../models/Subscription.js';
import { asyncHandler } from '../utils/httpError.js';
import { AppError } from '../utils/appError.js';
import { runWithTenant } from '../utils/tenantContext.js';
import { serializeCatalog, getPlan, comparePlans } from '../config/plans.js';
import { isBillingConfigured, toBillingError } from '../services/stripe.js';
import {
  createCheckoutSession,
  createPortalSession,
  previewPlanChange,
  changePlan,
  cancelSubscription,
  resumeSubscription,
  currentSubscription,
} from '../services/billing.js';
import { reconcileTenant, syncTenantPlan } from '../services/billingSync.js';
import { describeEntitlements } from '../services/entitlements.js';

/**
 * The read + command surface for subscription management.
 *
 * Reads are served entirely from the local mirror that the webhooks maintain,
 * so opening the billing page costs zero Stripe calls and still works when
 * Stripe is slow. Only the commands (checkout, plan change, cancel) talk to
 * Stripe, plus the explicit `/sync` escape hatch.
 */

function serializeSubscription(sub) {
  if (!sub) return null;
  return {
    id: String(sub._id),
    planId: sub.planId,
    interval: sub.interval,
    status: sub.status,
    entitled: isEntitled(sub),
    currentPeriodStart: sub.currentPeriodStart,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAt,
    trialEndsAt: sub.trialEndsAt,
    latestInvoiceStatus: sub.latestInvoiceStatus,
    // The client polls on this after checkout: when it advances past the
    // moment the browser came back from Stripe, the webhook has landed.
    syncedAt: sub.syncedAt,
    updatedAt: sub.updatedAt,
  };
}

function serializeInvoice(invoice) {
  return {
    id: String(invoice._id),
    number: invoice.number,
    status: invoice.status,
    amountDue: invoice.amountDue,
    amountPaid: invoice.amountPaid,
    amountRemaining: invoice.amountRemaining,
    currency: invoice.currency,
    planId: invoice.planId,
    description: invoice.description,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    issuedAt: invoice.issuedAt,
    paidAt: invoice.paidAt,
    // Stripe-hosted and short-lived by design — we link, never proxy.
    hostedInvoiceUrl: invoice.hostedInvoiceUrl,
    invoicePdfUrl: invoice.invoicePdfUrl,
  };
}

/** Fresh tenant read: `req.tenant` was cached by resolveTenant before any write. */
const freshTenant = (req) => Tenant.findById(req.tenant._id).lean();

/**
 * GET /api/billing/plans
 * The catalog plus what this workspace is on, so the pricing page can render
 * "Current plan" / "Upgrade" / "Downgrade" in one round trip.
 */
export const listPlans = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  const subscription = await currentSubscription(tenant);
  const currentPlanId = tenant.plan ?? 'free';
  // Only an ENTITLED subscription pins the billing interval — a cancelled one
  // must not make its old interval look like the current position.
  //
  // `isEntitled(...)` on the raw document, NOT `subscription.entitled`: that
  // field is computed during serialization and does not exist on the stored
  // row, so reading it here would silently be undefined and null out the
  // interval for every subscriber.
  const currentInterval = isEntitled(subscription) ? subscription.interval : null;

  /**
   * The action is computed per plan AND per interval, not per plan alone.
   *
   * Interval matters: a customer on Pro monthly who switches the toggle to
   * yearly is looking at a plan they are NOT currently on, and must be able to
   * move to it. Collapsing that to "same plan id = current" makes annual
   * billing unreachable from the UI — which is the one switch a business most
   * wants to offer.
   */
  const actionFor = (planId, interval) => {
    if (planId !== currentPlanId) {
      return comparePlans(planId, currentPlanId) > 0 ? 'upgrade' : 'downgrade';
    }
    // Same plan. Without an active subscription there is no interval to differ
    // from, so this really is the current position (the Free plan case).
    if (!currentInterval) return 'current';
    return interval === currentInterval ? 'current' : 'switch_interval';
  };

  res.json({
    plans: serializeCatalog().map((plan) => ({
      ...plan,
      // Plan-level, for the "Your plan" badge — that stays true whichever
      // interval the visitor is browsing.
      current: plan.id === currentPlanId,
      // Per-interval, for the button. Precomputed server-side so a label can
      // never drift from the action the server would actually take.
      actions: {
        monthly: actionFor(plan.id, 'monthly'),
        yearly: actionFor(plan.id, 'yearly'),
      },
    })),
    currentPlanId,
    currentInterval,
    subscription: serializeSubscription(subscription),
    billingEnabled: isBillingConfigured(),
  });
});

/** GET /api/billing/subscription — the polled endpoint after checkout. */
export const getSubscription = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  const subscription = await currentSubscription(tenant);
  const plan = getPlan(tenant.plan ?? 'free');

  res.json({
    plan: {
      id: plan.id,
      name: plan.name,
      limits: Object.fromEntries(
        Object.entries(plan.limits).map(([k, v]) => [k, Number.isFinite(v) ? v : null])
      ),
      features: plan.features,
    },
    subscription: serializeSubscription(subscription),
    hasBillingAccount: Boolean(tenant.stripeCustomerId),
    billingEnabled: isBillingConfigured(),
  });
});

/**
 * GET /api/billing/invoices — billing history, newest first.
 * Read from the local mirror, so paging is a plain indexed query.
 */
export const listInvoices = asyncHandler(async (req, res) => {
  const { page, limit, status } = req.query;
  const filter = status ? { status } : {};
  const skip = (page - 1) * limit;

  // Awaited inside the tenant context: a Mongoose query is lazy, and one that
  // escaped this callback unexecuted would run with no tenant bound — which
  // the scope plugin refuses, by design.
  const [invoices, total] = await runWithTenant(req.tenant, async () => {
    const results = await Promise.all([
      Invoice.find(filter).sort({ issuedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Invoice.countDocuments(filter),
    ]);
    return results;
  });

  res.json({
    invoices: invoices.map(serializeInvoice),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: skip + invoices.length < total,
  });
});

/**
 * GET /api/billing/usage
 *
 * What the workspace has consumed against what its plan allows — the data
 * behind the meters on the billing page, and the honest answer to "why was I
 * just told to upgrade?". Readable by any signed-in user: everyone bumps into
 * the limits, so everyone can see how close they are.
 */
export const getUsage = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  const entitlements = await runWithTenant(tenant, async () => {
    const described = await describeEntitlements(tenant.plan ?? 'free');
    return described;
  });

  res.json(entitlements);
});

/**
 * POST /api/billing/checkout — start a NEW subscription.
 * Returns the hosted Checkout URL; the browser navigates to Stripe from there.
 */
export const startCheckout = asyncHandler(async (req, res) => {
  const { planId, interval } = req.body;
  const tenant = await freshTenant(req);

  const session = await createCheckoutSession({
    tenant,
    user: req.billingUser,
    planId,
    interval,
    // Optional. When the client sends one, a resubmitted form returns the same
    // session rather than opening a second one.
    idempotencyKey: req.get('Idempotency-Key') || undefined,
  });

  res.status(201).json({ checkout: session });
});

/** POST /api/billing/portal — hand off to Stripe's hosted billing portal. */
export const openPortal = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  res.json({ portal: await createPortalSession({ tenant }) });
});

/** GET /api/billing/preview — what a plan switch costs right now. */
export const previewChange = asyncHandler(async (req, res) => {
  const { planId, interval } = req.query;
  const tenant = await freshTenant(req);
  res.json({ preview: await previewPlanChange({ tenant, planId, interval }) });
});

/** POST /api/billing/change — apply the upgrade or downgrade. */
export const applyPlanChange = asyncHandler(async (req, res) => {
  const { planId, interval } = req.body;
  const tenant = await freshTenant(req);

  const result = await changePlan({ tenant, planId, interval });
  const updated = await freshTenant(req);

  res.json({
    change: result,
    subscription: serializeSubscription(await currentSubscription(updated)),
    plan: updated.plan,
  });
});

/** POST /api/billing/cancel — schedule cancellation at period end. */
export const cancelPlan = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  const result = await cancelSubscription({ tenant });

  res.json({
    cancellation: result,
    subscription: serializeSubscription(await currentSubscription(tenant)),
  });
});

/** POST /api/billing/resume — undo a scheduled cancellation. */
export const resumePlan = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);
  const result = await resumeSubscription({ tenant });

  res.json({
    resumed: result,
    subscription: serializeSubscription(await currentSubscription(tenant)),
  });
});

/**
 * POST /api/billing/sync — pull state from Stripe and re-apply it.
 *
 * The user-visible repair for the two cases webhooks miss: local development
 * with no public tunnel, and an event that exhausted its retries. The UI
 * offers it as "Refresh billing status" when a checkout returns but the
 * expected plan has not appeared.
 */
export const syncBilling = asyncHandler(async (req, res) => {
  const tenant = await freshTenant(req);

  if (!tenant.stripeCustomerId) {
    // Nothing has ever been purchased — re-derive locally and report honestly.
    await syncTenantPlan(tenant._id);
    const refreshed = await freshTenant(req);
    return res.json({
      synced: false,
      reason: 'no-billing-account',
      plan: refreshed.plan,
      subscription: serializeSubscription(await currentSubscription(refreshed)),
    });
  }

  let summary;
  try {
    summary = await reconcileTenant(tenant);
  } catch (err) {
    throw toBillingError(err);
  }

  const refreshed = await freshTenant(req);
  res.json({
    synced: true,
    summary,
    plan: refreshed.plan,
    subscription: serializeSubscription(await currentSubscription(refreshed)),
  });
});

/**
 * Loads the requesting user once, for the receipt email on customer creation.
 * Kept out of `requireAuth` so no Week 1 route pays for the extra read.
 */
export const attachBillingUser = asyncHandler(async (req, _res, next) => {
  const user = await User.findById(req.user.userId).lean();
  if (!user) throw new AppError('UNAUTHORIZED', 'Your account no longer exists.');
  req.billingUser = { email: user.email, name: user.name, role: user.role };
  next();
});

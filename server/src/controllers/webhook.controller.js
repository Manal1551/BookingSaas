import { env } from '../config/env.js';
import { getStripe, isWebhookConfigured, idOf } from '../services/stripe.js';
import {
  resolveTenant,
  applySubscription,
  applyInvoice,
  syncTenantPlan,
} from '../services/billingSync.js';
import {
  claimEvent,
  markProcessed,
  markFailed,
} from '../services/webhookEvents.js';

/**
 * Stripe webhook endpoint.
 *
 * This is the only route in the app reachable without a session, without a
 * tenant subdomain, and from the public internet, so its security rests
 * entirely on the signature check. The order below is deliberate:
 *
 *   1. VERIFY the signature over the RAW body. Anyone can POST here; only
 *      Stripe can produce a valid `Stripe-Signature`. Nothing is parsed,
 *      logged, or acted on before this passes. The raw bytes matter — any
 *      re-serialisation of the parsed JSON changes the digest, which is why
 *      `express.raw` is mounted ahead of `express.json` for this path.
 *   2. REJECT replays. `constructEvent`'s tolerance bounds how old a signed
 *      payload may be, so a request captured off the wire cannot be resent
 *      days later.
 *   3. DEDUPE. Stripe delivers at least once; the ledger makes the *effects*
 *      exactly once.
 *   4. HANDLE, then acknowledge.
 *
 * On the response contract: a 2xx tells Stripe "delivered, stop retrying", so
 * we return 2xx for anything a retry could not fix (unknown event type,
 * unknown tenant, unknown price) and non-2xx only for genuinely transient
 * failures we want redelivered. Returning 500 for an event we will never be
 * able to process would just burn three days of retries.
 */

/** Events this app acts on. Anything else is acknowledged and ignored. */
const HANDLERS = {
  'checkout.session.completed': handleCheckoutCompleted,
  'checkout.session.async_payment_succeeded': handleCheckoutCompleted,
  'checkout.session.expired': handleCheckoutExpired,
  // A delayed payment method (bank debit, voucher) that ultimately failed.
  // Nothing to undo — no subscription was ever activated — but it must be
  // recorded, or the tenant simply appears to have abandoned checkout.
  'checkout.session.async_payment_failed': handleCheckoutFailed,

  'customer.subscription.created': handleSubscriptionChange,
  'customer.subscription.updated': handleSubscriptionChange,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'customer.subscription.paused': handleSubscriptionChange,
  'customer.subscription.resumed': handleSubscriptionChange,
  'customer.subscription.trial_will_end': handleSubscriptionChange,

  'invoice.created': handleInvoiceChange,
  'invoice.finalized': handleInvoiceChange,
  'invoice.paid': handleInvoiceChange,
  'invoice.payment_succeeded': handleInvoiceChange,
  'invoice.payment_failed': handleInvoiceChange,
  'invoice.voided': handleInvoiceChange,
  'invoice.marked_uncollectible': handleInvoiceChange,
};

/**
 * POST /api/webhooks/stripe
 *
 * `req.body` is a Buffer here (see routes/webhook.routes.js), not an object.
 * Written as a plain handler rather than through `asyncHandler` because its
 * error contract is Stripe's, not the app's: the reply is a bare status code
 * that decides whether Stripe retries, and it must never leak an envelope.
 */
export async function handleStripeWebhook(req, res) {
  if (!isWebhookConfigured()) {
    // No secret means no way to verify — refusing is the only safe answer.
    console.error('[stripe-webhook] received an event but STRIPE_WEBHOOK_SECRET is unset');
    return res.status(503).json({ error: 'Webhooks are not configured.' });
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe-Signature header.' });
  }

  // --- 1 & 2: verify signature and reject stale payloads -------------------
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body, // raw Buffer — do not touch before this line
      signature,
      env.STRIPE_WEBHOOK_SECRET,
      env.STRIPE_WEBHOOK_TOLERANCE_SECONDS
    );
  } catch (err) {
    // Bad signature, tampered body, or a payload older than the tolerance.
    // Log the reason, never the body.
    console.warn(`[stripe-webhook] rejected: ${err?.message}`);
    return res.status(400).json({ error: 'Signature verification failed.' });
  }

  // --- 3: dedupe -----------------------------------------------------------
  let claim;
  try {
    claim = await claimEvent(event);
  } catch (err) {
    console.error(`[stripe-webhook] ledger unavailable for ${event.id}: ${err?.message}`);
    // The database is down: ask Stripe to redeliver rather than silently drop.
    return res.status(503).json({ error: 'Temporarily unable to record the event.' });
  }

  if (claim.outcome === 'duplicate') {
    // Already fully handled. Acknowledge without doing the work again — this
    // is the line that makes duplicate delivery harmless.
    return res.status(200).json({ received: true, duplicate: true });
  }

  if (claim.outcome === 'in_flight') {
    // Another delivery of this same event is mid-handler. 409 keeps Stripe
    // retrying, and by the next attempt the original will have finished and
    // this becomes a plain duplicate.
    return res.status(409).json({ received: false, reason: 'in_progress' });
  }

  // --- 4: handle -----------------------------------------------------------
  const handler = HANDLERS[event.type];
  if (!handler) {
    await markProcessed(event.id, { result: 'ignored:unhandled-type' });
    return res.status(200).json({ received: true, handled: false });
  }

  try {
    const outcome = await handler(event);
    await markProcessed(event.id, {
      tenantId: outcome?.tenantId ?? null,
      result: outcome?.result ?? 'ok',
    });
    return res.status(200).json({ received: true, handled: true });
  } catch (err) {
    await markFailed(event.id, err).catch(() => {});
    console.error(`[stripe-webhook] ${event.type} ${event.id} failed: ${err?.message}`);
    // 500 so Stripe retries; the ledger row is now 'failed', which lets the
    // retry re-claim it.
    return res.status(500).json({ received: false });
  }
}

/** Every handler receives the event and returns a note for the ledger. */

/**
 * Checkout finished. The subscription is fetched fresh rather than read from
 * the session, because the session's copy is a snapshot from before any
 * immediate invoice settled.
 */
async function handleCheckoutCompleted(event) {
  const session = event.data.object;

  if (session.mode !== 'subscription') {
    return { result: 'ignored:non-subscription-checkout' };
  }

  const tenant = await resolveTenant({
    customerId: idOf(session.customer),
    metadata: session.metadata,
  });
  if (!tenant) return { result: 'ignored:unknown-tenant' };

  // Payment still clearing (delayed methods) — the subscription is not usable
  // yet, and the subscription.* events will carry the real state.
  if (session.payment_status === 'unpaid' && session.status !== 'complete') {
    return { tenantId: tenant._id, result: 'deferred:payment-pending' };
  }

  const subscriptionId = idOf(session.subscription);
  if (!subscriptionId) return { tenantId: tenant._id, result: 'ignored:no-subscription' };

  /**
   * Use the session's own copy when it is already an expanded object, and only
   * call Stripe when all we have is an id.
   *
   * Stripe sends a bare id by default, so the fetch is the usual path — the
   * session snapshot predates any immediate invoice settling, and the fresh
   * read is what gets the real status. But an endpoint configured to expand
   * `data.object.subscription`, or a replay carrying an expanded object, is
   * already holding everything needed, and spending an API call to re-fetch
   * what is in hand would just add a failure mode.
   */
  const subscription =
    typeof session.subscription === 'object' && session.subscription?.items
      ? session.subscription
      : await getStripe().subscriptions.retrieve(subscriptionId, {
          expand: ['items.data.price'],
        });

  const applied = await applySubscription({
    tenant,
    subscription,
    eventAt: new Date(event.created * 1000),
    eventId: event.id,
  });

  return {
    tenantId: tenant._id,
    result: applied.applied ? `activated:${applied.planId}` : `skipped:${applied.reason}`,
  };
}

/** A delayed payment method failed to clear. Recorded for support. */
async function handleCheckoutFailed(event) {
  const session = event.data.object;
  const tenant = await resolveTenant({
    customerId: idOf(session.customer),
    metadata: session.metadata,
  });
  return { tenantId: tenant?._id ?? null, result: 'noted:async-payment-failed' };
}

/** The customer abandoned Checkout. Nothing to undo — recorded for support. */
async function handleCheckoutExpired(event) {
  const session = event.data.object;
  const tenant = await resolveTenant({
    customerId: idOf(session.customer),
    metadata: session.metadata,
  });
  return { tenantId: tenant?._id ?? null, result: 'noted:checkout-expired' };
}

/** created / updated / paused / resumed / trial_will_end all mirror the same way. */
async function handleSubscriptionChange(event) {
  const subscription = event.data.object;

  const tenant = await resolveTenant({
    customerId: idOf(subscription.customer),
    metadata: subscription.metadata,
  });
  if (!tenant) return { result: 'ignored:unknown-tenant' };

  const applied = await applySubscription({
    tenant,
    subscription,
    eventAt: new Date(event.created * 1000),
    eventId: event.id,
  });

  return {
    tenantId: tenant._id,
    result: applied.applied
      ? `synced:${applied.planId}:${subscription.status}`
      : `skipped:${applied.reason}`,
  };
}

/**
 * The subscription ended for good (period elapsed after a cancellation, or it
 * was deleted outright). Mirroring the object sets status `canceled`, and
 * `syncTenantPlan` then drops the tenant back to Free.
 */
async function handleSubscriptionDeleted(event) {
  const subscription = event.data.object;

  const tenant = await resolveTenant({
    customerId: idOf(subscription.customer),
    metadata: subscription.metadata,
  });
  if (!tenant) return { result: 'ignored:unknown-tenant' };

  await applySubscription({
    tenant,
    subscription: { ...subscription, status: 'canceled' },
    eventAt: new Date(event.created * 1000),
    eventId: event.id,
  });

  // Called explicitly: if the price was unknown the apply above bailed out,
  // and the tenant must still lose its entitlement.
  const plan = await syncTenantPlan(tenant._id);
  return { tenantId: tenant._id, result: `canceled:downgraded-to:${plan}` };
}

/** Every invoice.* event mirrors the invoice; the status carries the meaning. */
async function handleInvoiceChange(event) {
  const invoice = event.data.object;

  const tenant = await resolveTenant({
    customerId: idOf(invoice.customer),
    metadata: invoice.metadata,
  });
  if (!tenant) return { result: 'ignored:unknown-tenant' };

  const applied = await applyInvoice({
    tenant,
    invoice,
    eventAt: new Date(event.created * 1000),
  });

  // A failed payment moves the subscription to past_due/unpaid on Stripe's
  // side; re-derive so a dunning failure is reflected without waiting for the
  // separate subscription.updated event.
  if (event.type === 'invoice.payment_failed') {
    await syncTenantPlan(tenant._id);
  }

  return {
    tenantId: tenant._id,
    result: applied.applied
      ? `invoice:${invoice.status}`
      : `skipped:${applied.reason}`,
  };
}

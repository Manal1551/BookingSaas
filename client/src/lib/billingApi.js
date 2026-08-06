import { bookingHttp, BookingApiError, ERROR_CODES } from './bookingClient.js';

/**
 * Client for `/api/billing/*`.
 *
 * The transport from `bookingClient.js` is reused rather than reimplemented:
 * the billing routes answer with the very same `{ error: { code, message,
 * details, requestId } }` envelope, and the retry policy it encodes (retry
 * GETs and network blips, never a bare POST) is exactly right for money
 * endpoints too.
 *
 * `BILLING_ERROR_CODES` extends the shared union with the codes only billing
 * emits, so a caller can branch on them without string literals.
 */

export const BILLING_ERROR_CODES = Object.freeze({
  ...ERROR_CODES,
  BILLING_NOT_CONFIGURED: 'BILLING_NOT_CONFIGURED',
  PLAN_UNAVAILABLE: 'PLAN_UNAVAILABLE',
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
  PLAN_UNCHANGED: 'PLAN_UNCHANGED',
  STRIPE_ERROR: 'STRIPE_ERROR',
  PLAN_LIMIT_EXCEEDED: 'PLAN_LIMIT_EXCEEDED',
});

/**
 * True when a failure was a plan limit rather than a mistake by the user.
 *
 * Worth its own predicate because the right response is completely different:
 * the request was valid and retrying it unchanged will fail again, so the UI
 * must offer an upgrade, not a correction.
 */
export function isPlanLimitError(err) {
  return err?.code === BILLING_ERROR_CODES.PLAN_LIMIT_EXCEEDED;
}

export { BookingApiError as BillingApiError };

function toQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const billingApi = {
  /** Catalog + what this workspace is on, in one round trip. */
  plans: (opts) => bookingHttp.get('/api/billing/plans', opts),

  subscription: (opts) => bookingHttp.get('/api/billing/subscription', opts),

  invoices: (params, opts) =>
    bookingHttp.get(`/api/billing/invoices${toQuery(params)}`, opts),

  /**
   * Starts a Checkout Session. The key is minted once per page load and reused
   * across retries, so a double-clicked Upgrade button reuses the same Stripe
   * session instead of opening a second one.
   */
  checkout: ({ planId, interval }, idempotencyKey, opts = {}) =>
    bookingHttp.post(
      '/api/billing/checkout',
      { planId, interval },
      {
        ...opts,
        headers: {
          ...(opts.headers || {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
      }
    ),

  portal: (opts) => bookingHttp.post('/api/billing/portal', undefined, opts),

  /** What a switch costs right now, quoted by Stripe. */
  preview: ({ planId, interval }, opts) =>
    bookingHttp.get(`/api/billing/preview${toQuery({ planId, interval })}`, opts),

  change: ({ planId, interval }, opts) =>
    bookingHttp.post('/api/billing/change', { planId, interval }, opts),

  cancel: (opts) => bookingHttp.post('/api/billing/cancel', undefined, opts),

  resume: (opts) => bookingHttp.post('/api/billing/resume', undefined, opts),

  /** Consumption against the plan's limits, for the meters. */
  usage: (opts) => bookingHttp.get('/api/billing/usage', opts),

  /** Manual reconcile — the "webhook never arrived" escape hatch. */
  sync: (opts) => bookingHttp.post('/api/billing/sync', undefined, opts),
};

// --- Formatting -----------------------------------------------------------

/**
 * Amounts travel as integer minor units (2900 = $29.00), exactly as Stripe
 * stores them. Convert only at the point of display — never do arithmetic on
 * the divided value.
 */
export function formatMoney(minorUnits, currency = 'usd') {
  const amount = (minorUnits ?? 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
      // Show cents only when there are any: "$29" reads better than "$29.00"
      // on a pricing table, but an invoice for $12.34 must keep its cents.
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency.toUpperCase()} ${amount.toFixed(2)}`;
  }
}

export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** "$290/yr" reads as a rate; "$24.17/mo billed yearly" is what people compare. */
export function monthlyEquivalent(yearlyMinorUnits, currency = 'usd') {
  return formatMoney(Math.round(yearlyMinorUnits / 12), currency);
}

/** How much a yearly plan saves against 12x its monthly price, as a percent. */
export function yearlySavingPercent(monthly, yearly) {
  if (!monthly || !yearly) return 0;
  const full = monthly * 12;
  if (full <= yearly) return 0;
  return Math.round(((full - yearly) / full) * 100);
}

/**
 * Human copy for a subscription status. `past_due` is deliberately not phrased
 * as an outage — the plan still works while Stripe retries the card, and
 * telling the user otherwise causes needless panic.
 */
export const STATUS_COPY = Object.freeze({
  trialing: { label: 'Trialing', tone: 'info', note: 'Your trial is running.' },
  active: { label: 'Active', tone: 'success', note: null },
  past_due: {
    label: 'Payment due',
    tone: 'warning',
    note: 'Your last payment failed. Update your card to avoid losing access.',
  },
  unpaid: {
    label: 'Unpaid',
    tone: 'error',
    note: 'We could not collect payment. Paid features are switched off.',
  },
  canceled: {
    label: 'Cancelled',
    tone: 'neutral',
    note: 'This subscription has ended.',
  },
  incomplete: {
    label: 'Incomplete',
    tone: 'warning',
    note: 'Payment was never confirmed. Start checkout again to finish.',
  },
  incomplete_expired: {
    label: 'Expired',
    tone: 'neutral',
    note: 'The payment window expired before it was confirmed.',
  },
  paused: { label: 'Paused', tone: 'neutral', note: 'Billing is paused.' },
});

export function describeStatus(status) {
  return (
    STATUS_COPY[status] ?? { label: status ?? 'Unknown', tone: 'neutral', note: null }
  );
}

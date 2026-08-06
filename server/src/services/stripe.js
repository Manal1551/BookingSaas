import Stripe from 'stripe';
import { env } from '../config/env.js';
import { AppError } from '../utils/appError.js';

/**
 * The Stripe client, constructed lazily.
 *
 * Lazily, because billing is optional: a contributor with no Stripe account
 * must still be able to run the app and the Week 1/2 test suites. Constructing
 * at import time would either crash or force a fake key into every environment.
 * Instead nothing touches Stripe until a billing route is actually called, and
 * `requireBilling` turns "not configured" into a clean 503 the UI can explain.
 */

let client = null;

/** True when this deployment can talk to Stripe at all. */
export function isBillingConfigured() {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** True when this deployment can additionally *receive* verified webhooks. */
export function isWebhookConfigured() {
  return Boolean(env.STRIPE_WEBHOOK_SECRET);
}

/** @returns {Stripe} */
export function getStripe() {
  if (!isBillingConfigured()) {
    throw new AppError(
      'BILLING_NOT_CONFIGURED',
      'Billing is not set up on this deployment yet.'
    );
  }
  if (!client) {
    client = new Stripe(env.STRIPE_SECRET_KEY, {
      // Pin the version: a Stripe-side upgrade must never silently change the
      // shape of the objects the webhook handlers destructure.
      apiVersion: '2025-10-29.clover',
      maxNetworkRetries: 2, // Stripe's SDK retries with its own idempotency keys
      timeout: 15_000,
      appInfo: { name: 'booking-saas', version: '0.1.0' },
    });
  }
  return client;
}

/** Route guard: 503 early rather than failing deep inside a handler. */
export function requireBilling(_req, _res, next) {
  if (!isBillingConfigured()) {
    return next(
      new AppError(
        'BILLING_NOT_CONFIGURED',
        'Billing is not available on this deployment. Set STRIPE_SECRET_KEY to enable it.'
      )
    );
  }
  return next();
}

/**
 * Translates a Stripe SDK error into our envelope.
 *
 * Card and validation failures are the customer's problem and carry a message
 * written for them, so that message is forwarded. Everything else (auth,
 * connection, API errors) is our problem and must not leak Stripe internals or
 * key hints to the browser.
 */
export function toBillingError(err) {
  if (err instanceof AppError) return err;

  switch (err?.type) {
    case 'StripeCardError':
      return new AppError(
        'STRIPE_ERROR',
        err.message || 'Your card was declined. Try a different payment method.'
      );
    case 'StripeInvalidRequestError':
      // A bad price ID or a stale subscription id — a config/state bug on our
      // side, but the caller can act on it (pick a different plan).
      return new AppError(
        'PLAN_UNAVAILABLE',
        'That plan could not be started. Please pick another plan or contact support.'
      );
    case 'StripeRateLimitError':
      return new AppError(
        'RATE_LIMITED',
        'Too many billing requests. Please try again in a moment.'
      );
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return new AppError(
        'STRIPE_ERROR',
        'Could not reach our payment provider. Please try again shortly.'
      );
    case 'StripeAuthenticationError':
      return new AppError(
        'BILLING_NOT_CONFIGURED',
        'Billing is misconfigured on this deployment.'
      );
    default:
      return new AppError('STRIPE_ERROR', 'The payment provider rejected that request.');
  }
}

/** Stripe sends UNIX seconds; every date in our models is a real Date. */
export function fromStripeTimestamp(seconds) {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

/** Accepts either an expanded object or a bare id string. */
export function idOf(value) {
  if (!value) return null;
  return typeof value === 'string' ? value : (value.id ?? null);
}

import { Router } from 'express';
import express from 'express';
import { handleStripeWebhook } from '../controllers/webhook.controller.js';

const router = Router();

/**
 * `express.raw` — not `express.json` — and that is the whole point.
 *
 * Stripe signs the exact bytes it sent. `JSON.parse` followed by
 * `JSON.stringify` can reorder keys, change number formatting, and re-escape
 * unicode; the result no longer hashes to the signed digest and every event
 * would be rejected as forged. So this router keeps the untouched Buffer, and
 * app.js mounts it BEFORE the global `express.json()` so nothing else has a
 * chance to consume the stream first.
 *
 * The 1 MB ceiling is well above any real Stripe event and stops an unbounded
 * body from being buffered on an unauthenticated endpoint.
 */
router.post(
  '/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  handleStripeWebhook
);

// No `notFound` handler here: unknown paths fall through to the app's own,
// which keeps this router to exactly one public surface.

export default router;

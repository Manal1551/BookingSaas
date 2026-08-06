import { z } from 'zod';
import { PLAN_IDS, BILLING_INTERVALS } from '../config/plans.js';

/**
 * Schemas for `/api/billing/*`.
 *
 * Same discipline as the Booking API: a handler never inspects a raw value.
 * Note what is NOT accepted anywhere here — a price ID, an amount, or a
 * customer ID. The client names a plan and an interval; the server resolves
 * those to a Stripe price from its own catalog. A client that could name a
 * price could name a $0 one.
 */

export const planSelectionSchema = z.object({
  planId: z.enum(PLAN_IDS, {
    errorMap: () => ({ message: `Must be one of: ${PLAN_IDS.join(', ')}` }),
  }),
  interval: z
    .enum(BILLING_INTERVALS, {
      errorMap: () => ({ message: `Must be one of: ${BILLING_INTERVALS.join(', ')}` }),
    })
    .default('monthly'),
});

/** Same shape, but arriving as query params on the proration preview. */
export const planSelectionQuerySchema = planSelectionSchema;

export const listInvoicesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum(['draft', 'open', 'paid', 'uncollectible', 'void'])
    .optional(),
});

/**
 * Optional on billing writes. Forwarded to Stripe as its own idempotency key,
 * so a double-submitted "Upgrade" reuses the first Checkout Session instead of
 * opening a second one.
 */
export const idempotencyKeySchema = z
  .string()
  .uuid('Idempotency-Key must be a UUID')
  .optional();

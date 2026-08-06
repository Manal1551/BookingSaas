import mongoose from 'mongoose';

/**
 * The webhook dedupe ledger.
 *
 * Stripe guarantees *at-least-once* delivery: it retries on any non-2xx, on a
 * timeout, and occasionally sends the same event twice even after a 200. Every
 * handler here therefore has to be idempotent, and this collection is what
 * makes that cheap — one row per Stripe event id, claimed via a unique index
 * before any side effect runs.
 *
 * Deliberately NOT tenant-scoped. A webhook arrives on the root domain with no
 * subdomain and no session, so there is no tenant in context when the claim
 * happens; the tenant is only resolved later, from the Stripe customer. Making
 * this collection global also means dedupe is correct even if two tenants
 * somehow shared a customer — Stripe event ids are globally unique.
 *
 * The state machine mirrors the Week 2 idempotency protocol:
 *
 *   processing — claimed, handler running. A duplicate arriving now is told
 *                "already in flight" and Stripe simply retries later.
 *   processed  — handler finished. Duplicates are acknowledged with 200 and
 *                do no work at all.
 *   failed     — handler threw. Kept for diagnosis, but the claim is released
 *                so Stripe's next retry can genuinely re-run it.
 */

export const WEBHOOK_EVENT_INDEX = 'webhook_event_id_unique';

/** Long enough to outlive Stripe's ~3-day retry schedule, then self-cleaning. */
export const WEBHOOK_EVENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const webhookEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, trim: true },
    type: { type: String, required: true },
    // Stripe's own `created` (seconds -> Date). Used for ordering decisions.
    eventCreatedAt: { type: Date, required: true },

    state: {
      type: String,
      enum: ['processing', 'processed', 'failed'],
      required: true,
      default: 'processing',
    },

    // Resolved during handling; null when the event referenced a customer we
    // do not know (e.g. one created directly in the Stripe dashboard).
    tenantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Tenant',
      default: null,
      index: true,
    },

    // Short human note: which branch ran, or why it was skipped. Invaluable
    // when reconciling "Stripe says X but the app says Y".
    result: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 1 },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'webhook_events' }
);

webhookEventSchema.index(
  { eventId: 1 },
  { unique: true, name: WEBHOOK_EVENT_INDEX }
);
webhookEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookEvent =
  mongoose.models.WebhookEvent ||
  mongoose.model('WebhookEvent', webhookEventSchema);

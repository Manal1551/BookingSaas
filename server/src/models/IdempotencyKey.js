import mongoose from 'mongoose';
import { tenantScopePlugin } from '../middleware/tenantScopePlugin.js';

/** Keys live for 24h, then Mongo's TTL monitor removes them automatically. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_INDEX = 'idempotency_key_unique';

/**
 * Record of one idempotent request.
 *
 * `state` is what makes the two-phase protocol work without transactions
 * (this deployment runs standalone Mongo, which has no multi-document
 * transactions):
 *
 *   in_progress — inserted BEFORE the booking is created. The unique index on
 *                 { tenantId, key } means a concurrent duplicate loses the
 *                 insert rather than racing a read-then-write, and is told the
 *                 original is still running.
 *   completed   — the booking succeeded and the exact response that was sent
 *                 is stored here, so a replay returns it byte for byte
 *                 without re-executing anything.
 *
 * A failed attempt deletes its record so the caller may retry the same key.
 */
const idempotencyKeySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, maxlength: 120 },
    // sha256 of the canonicalised request — same key + different body is a
    // client bug, and must be reported rather than silently replayed.
    fingerprint: { type: String, required: true },
    state: {
      type: String,
      enum: ['in_progress', 'completed'],
      required: true,
      default: 'in_progress',
    },
    responseStatus: { type: Number, default: null },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },
    expiresAt: { type: Date, required: true },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    collection: 'idempotency_keys',
  }
);

// Keys are scoped per tenant: two tenants may legitimately use the same UUID.
idempotencyKeySchema.index(
  { tenantId: 1, key: 1 },
  { unique: true, name: IDEMPOTENCY_KEY_INDEX }
);
// TTL: expireAfterSeconds 0 means "remove once expiresAt is in the past".
idempotencyKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

idempotencyKeySchema.plugin(tenantScopePlugin);

export const IdempotencyKey =
  mongoose.models.IdempotencyKey ||
  mongoose.model('IdempotencyKey', idempotencyKeySchema);

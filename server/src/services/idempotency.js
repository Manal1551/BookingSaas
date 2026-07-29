import { createHash } from 'node:crypto';
import {
  IdempotencyKey,
  IDEMPOTENCY_TTL_MS,
} from '../models/IdempotencyKey.js';
import { AppError, isDuplicateKeyError } from '../utils/appError.js';

/**
 * Idempotent request execution, two-phase and transaction-free.
 *
 * Standalone MongoDB has no multi-document transactions, so "create the
 * booking and persist the key atomically" is achieved with an insert-first
 * protocol whose atomicity comes from a unique index instead:
 *
 *   1. INSERT the key as `in_progress`. The unique { tenantId, key } index
 *      decides the winner of any race — there is no read-then-write window.
 *      A losing insert tells us the state of the original attempt:
 *        · different fingerprint -> IDEMPOTENCY_KEY_REUSE
 *        · still in_progress     -> REQUEST_IN_PROGRESS
 *        · completed             -> replay the stored response
 *   2. Run the handler (create the booking).
 *   3. UPDATE the key to `completed`, storing the exact status + body sent.
 *
 * If step 2 throws, the key record is deleted so a corrected retry may reuse
 * the same key. The trade-off is deliberate and documented in API.md: only
 * successful responses are replayable; a failed attempt does not burn the key.
 */

/** Recursively sorts object keys so logically-equal bodies hash identically. */
function canonicalise(value) {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = canonicalise(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Fingerprint of a request: the body plus who is making it and where. Tenant
 * and user are included so one tenant's key can never replay another's
 * response even if the unique index were ever relaxed.
 *
 * @param {{ method: string, path: string, tenantId: unknown, userId: unknown, body: unknown }} req
 */
export function fingerprintRequest({ method, path, tenantId, userId, body }) {
  const canonical = canonicalise({
    method,
    path,
    tenantId: String(tenantId),
    userId: String(userId),
    body,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * @typedef {{ status: number, body: unknown }} HandlerResult
 * @typedef {HandlerResult & { replayed: boolean }} IdempotentOutcome
 */

/** Decides what a losing insert means. Never re-executes the handler. */
async function replayOrConflict(key, fingerprint) {
  const existing = await IdempotencyKey.findOne({ key }).lean();

  if (!existing) {
    // The record was TTL-purged between our failed insert and this read.
    // Vanishingly rare; treat as in-flight so the client simply retries.
    throw new AppError(
      'REQUEST_IN_PROGRESS',
      'That request is still being processed. Please retry in a moment.'
    );
  }

  if (existing.fingerprint !== fingerprint) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSE',
      'This Idempotency-Key was already used with a different request body. ' +
        'Generate a new key for a new booking.'
    );
  }

  if (existing.state === 'in_progress') {
    throw new AppError(
      'REQUEST_IN_PROGRESS',
      'An identical request is already being processed. Please retry in a moment.'
    );
  }

  return {
    status: existing.responseStatus,
    body: existing.responseBody,
    replayed: true,
  };
}

/**
 * @param {object} args
 * @param {string} args.key         validated UUID from the Idempotency-Key header
 * @param {string} args.fingerprint from `fingerprintRequest`
 * @param {() => Promise<HandlerResult>} args.run the side-effecting work
 * @returns {Promise<IdempotentOutcome>}
 */
export async function withIdempotency({ key, fingerprint, run }) {
  // --- Phase 1: claim the key ---------------------------------------------
  try {
    await IdempotencyKey.create({
      key,
      fingerprint,
      state: 'in_progress',
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    return replayOrConflict(key, fingerprint);
  }

  // --- Phase 2: do the work ------------------------------------------------
  let result;
  try {
    result = await run();
  } catch (err) {
    // Release the key so the caller can fix the request and retry with it.
    await IdempotencyKey.deleteOne({ key }).catch(() => {});
    throw err;
  }

  // --- Phase 3: record the response for future replays ---------------------
  await IdempotencyKey.updateOne(
    { key },
    {
      $set: {
        state: 'completed',
        responseStatus: result.status,
        responseBody: result.body,
      },
    }
  );

  return { ...result, replayed: false };
}

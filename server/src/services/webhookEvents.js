import {
  WebhookEvent,
  WEBHOOK_EVENT_TTL_MS,
} from '../models/WebhookEvent.js';
import { isDuplicateKeyError } from '../utils/appError.js';

/**
 * Exactly-once *effects* over Stripe's at-least-once *delivery*.
 *
 * Stripe retries any event it does not see a 2xx for, with backoff, for up to
 * about three days — and can legitimately deliver the same event twice even
 * after a success. Without a ledger, a retried `invoice.paid` would file a
 * second invoice row and a retried `subscription.updated` could resurrect a
 * plan the tenant already left.
 *
 * Same two-phase shape as the Week 2 idempotency service, and for the same
 * reason: the atomicity comes from a unique index, not a transaction, so it is
 * correct on standalone MongoDB.
 *
 *   claimEvent()  INSERT { eventId, state: 'processing' }
 *                 · insert wins  -> we own it, run the handler
 *                 · insert loses -> inspect the existing row:
 *                     processed  -> duplicate, ack with no work
 *                     processing -> in flight, ask Stripe to retry
 *                     failed     -> a previous attempt died, retry it
 *   markProcessed()  state -> 'processed', with a note on what was done
 *   markFailed()     state -> 'failed', so the next retry is allowed through
 */

/** @typedef {{ outcome: 'claimed'|'duplicate'|'in_flight'|'retry' }} ClaimResult */

/**
 * @param {{ id: string, type: string, created: number }} event
 * @returns {Promise<ClaimResult>}
 */
export async function claimEvent(event) {
  const eventCreatedAt = new Date(event.created * 1000);

  try {
    await WebhookEvent.create({
      eventId: event.id,
      type: event.type,
      eventCreatedAt,
      state: 'processing',
      expiresAt: new Date(Date.now() + WEBHOOK_EVENT_TTL_MS),
    });
    return { outcome: 'claimed' };
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
  }

  const existing = await WebhookEvent.findOne({ eventId: event.id }).lean();

  // TTL-purged between our failed insert and this read — treat as never seen.
  if (!existing) return { outcome: 'claimed' };

  if (existing.state === 'processed') return { outcome: 'duplicate' };

  if (existing.state === 'processing') {
    // A concurrent delivery of the same event holds the claim. Whether this is
    // a genuine race or an attempt that died mid-flight is decided by age: a
    // handler that has been "processing" for minutes is not still running.
    const stuckFor = Date.now() - new Date(existing.updatedAt ?? existing.createdAt).getTime();
    if (stuckFor > 60_000) {
      await WebhookEvent.updateOne(
        { eventId: event.id },
        { $set: { state: 'processing' }, $inc: { attempts: 1 } }
      );
      return { outcome: 'retry' };
    }
    return { outcome: 'in_flight' };
  }

  // state === 'failed' — a previous attempt threw; this retry may proceed.
  await WebhookEvent.updateOne(
    { eventId: event.id },
    { $set: { state: 'processing', error: null }, $inc: { attempts: 1 } }
  );
  return { outcome: 'retry' };
}

export async function markProcessed(eventId, { tenantId = null, result = null } = {}) {
  await WebhookEvent.updateOne(
    { eventId },
    { $set: { state: 'processed', tenantId, result, error: null } }
  );
}

export async function markFailed(eventId, error) {
  await WebhookEvent.updateOne(
    { eventId },
    {
      $set: {
        state: 'failed',
        // Store the message only — a stack could carry request payloads.
        error: String(error?.message ?? error).slice(0, 500),
      },
    }
  );
}

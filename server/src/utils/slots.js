import { SLOT_MINUTES, MAX_DURATION_MINUTES } from '../validation/booking.schemas.js';

const SLOT_MS = SLOT_MINUTES * 60 * 1000;
const MAX_SLOTS = MAX_DURATION_MINUTES / SLOT_MINUTES;

/**
 * Expands a booking window into the grid slots it occupies.
 *
 * This is what turns "no overlapping bookings" — a range constraint Mongo
 * cannot express — into a plain uniqueness constraint it can: two bookings
 * overlap if and only if they share a slot, so a unique index over
 * `{ tenantId, resourceId, slotKeys }` rejects overlaps in the database
 * itself, with no read-then-write race.
 *
 * The range is half-open `[start, end)`, so a 10:00–10:30 booking and a
 * 10:30–11:00 booking are back-to-back rather than conflicting.
 *
 * Inputs are guaranteed grid-aligned by `refineBookingWindow`, so the slot
 * boundaries are exact and the index never reports a false conflict.
 *
 * @param {Date|string} startAt
 * @param {Date|string} endAt
 * @returns {number[]} slot indices (epoch / SLOT_MS)
 */
export function slotKeysFor(startAt, endAt) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error('slotKeysFor: invalid booking window');
  }

  const first = Math.floor(start / SLOT_MS);
  const last = Math.ceil(end / SLOT_MS);
  const count = last - first;

  // Defence in depth: the Zod duration cap should already prevent this, so
  // reaching it means a caller bypassed validation.
  if (count > MAX_SLOTS) {
    throw new Error(
      `slotKeysFor: window spans ${count} slots, exceeding the ${MAX_SLOTS}-slot cap`
    );
  }

  const keys = new Array(count);
  for (let i = 0; i < count; i += 1) keys[i] = first + i;
  return keys;
}

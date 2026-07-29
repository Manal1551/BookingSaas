import { z } from 'zod';
import { Booking, ACTIVE_STATUSES, SLOT_INDEX_NAME } from '../models/Booking.js';
import { asyncHandler } from '../utils/httpError.js';
import { AppError, isDuplicateKeyError } from '../utils/appError.js';
import { zodIssuesToDetails } from '../utils/errorDetails.js';
import { slotKeysFor } from '../utils/slots.js';
import { validateHeader } from '../middleware/validate.js';
import { fingerprintRequest, withIdempotency } from '../services/idempotency.js';
import {
  idempotencyKeySchema,
  versionSchema,
  refineBookingWindow,
} from '../validation/booking.schemas.js';

// Re-exported for tests and any importer expecting schemas alongside the
// controller. The validation module remains the source of truth.
export {
  createBookingInputSchema,
  updateBookingInputSchema,
  listBookingsQuerySchema,
  bookingIdParamsSchema,
} from '../validation/booking.schemas.js';

/**
 * Wire format for a booking. `version` is the optimistic-concurrency token
 * clients must echo back on PATCH; `slotKeys` is an internal derivation and
 * is deliberately not exposed.
 */
function serializeBooking(booking) {
  return {
    id: String(booking._id),
    customerName: booking.customerName,
    customerEmail: booking.customerEmail,
    serviceName: booking.serviceName,
    resourceId: booking.resourceId,
    startAt: booking.startAt,
    endAt: booking.endAt,
    notes: booking.notes,
    status: booking.status,
    version: booking.__v ?? 0,
    createdAt: booking.createdAt,
    updatedAt: booking.updatedAt,
  };
}

/** Slots are held only while the booking is active; cancelling frees them. */
function slotsForStatus(status, startAt, endAt) {
  return ACTIVE_STATUSES.includes(status) ? slotKeysFor(startAt, endAt) : [];
}

function bookingConflict() {
  return new AppError(
    'BOOKING_CONFLICT',
    'That resource is already booked for part of this time range.'
  );
}

/**
 * Re-applies the shared window rules to a MERGED update (incoming fields laid
 * over the stored booking), so a PATCH cannot produce a state that a POST
 * would have rejected. Reuses `refineBookingWindow` rather than restating it.
 */
function assertMergedWindow({ startAt, endAt }, { enforceFuture }) {
  const merged = z
    .object({ startAt: z.string(), endAt: z.string() })
    .superRefine((data, ctx) => refineBookingWindow(data, ctx, { enforceFuture }));

  const parsed = merged.safeParse({
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  });

  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      'The request failed validation.',
      zodIssuesToDetails(parsed.error.issues, 'body')
    );
  }
}

/**
 * Optimistic-concurrency token, from `If-Match` (preferred) or a body
 * `version`. ETag syntax (`W/"3"` / `"3"`) is tolerated.
 */
function resolveVersion(req, bodyVersion) {
  const header = req.get('If-Match');
  if (header) {
    const cleaned = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    return validateHeaderVersion(cleaned);
  }
  if (bodyVersion !== undefined) return bodyVersion;

  throw new AppError(
    'VALIDATION_ERROR',
    'An If-Match header or a `version` field is required to update a booking.',
    [{ path: 'headers.If-Match', message: 'Required for optimistic concurrency' }]
  );
}

function validateHeaderVersion(value) {
  const parsed = versionSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'The `If-Match` header is invalid.', [
      { path: 'headers.If-Match', message: parsed.error.issues[0].message },
    ]);
  }
  return parsed.data;
}

/**
 * GET /api/bookings
 * Filters: from, to (on startAt), status, resourceId. Paginated + sortable.
 * tenantId is injected by the scope plugin — never set here.
 */
export const listBookings = asyncHandler(async (req, res) => {
  const { from, to, status, resourceId, page, limit, sort } = req.query;

  const filter = {};
  if (from || to) {
    filter.startAt = {};
    if (from) filter.startAt.$gte = new Date(from);
    if (to) filter.startAt.$lt = new Date(to);
  }
  if (status) filter.status = status;
  if (resourceId) filter.resourceId = resourceId;

  const sortSpec = sort.startsWith('-')
    ? { [sort.slice(1)]: -1 }
    : { [sort]: 1 };

  const skip = (page - 1) * limit;
  const [bookings, total] = await Promise.all([
    Booking.find(filter).sort(sortSpec).skip(skip).limit(limit).lean(),
    Booking.countDocuments(filter),
  ]);

  res.json({
    bookings: bookings.map(serializeBooking),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore: skip + bookings.length < total,
  });
});

/**
 * POST /api/bookings — idempotent.
 *
 * An `Idempotency-Key` header (UUID) is REQUIRED. The create runs inside the
 * two-phase idempotency protocol, so a replayed key returns the stored
 * response without touching the database.
 */
export const createBooking = asyncHandler(async (req, res) => {
  const key = validateHeader(req, 'Idempotency-Key', idempotencyKeySchema);
  const input = req.body;

  const fingerprint = fingerprintRequest({
    method: 'POST',
    path: '/api/bookings',
    tenantId: req.tenant._id,
    userId: req.user.userId,
    body: input,
  });

  const outcome = await withIdempotency({
    key,
    fingerprint,
    run: async () => {
      const startAt = new Date(input.startAt);
      const endAt = new Date(input.endAt);
      const status = input.status ?? 'pending';

      try {
        const booking = await Booking.create({
          ...input,
          startAt,
          endAt,
          status,
          slotKeys: slotsForStatus(status, startAt, endAt),
        });
        return { status: 201, body: { booking: serializeBooking(booking) } };
      } catch (err) {
        if (isDuplicateKeyError(err, SLOT_INDEX_NAME)) throw bookingConflict();
        throw err;
      }
    },
  });

  if (outcome.replayed) res.set('Idempotent-Replay', 'true');
  res.status(outcome.status).json(outcome.body);
});

/** GET /api/bookings/:id */
export const getBooking = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id).lean();
  if (!booking) throw new AppError('NOT_FOUND', 'Booking not found.');
  res.set('ETag', `"${booking.__v ?? 0}"`);
  res.json({ booking: serializeBooking(booking) });
});

/**
 * PATCH /api/bookings/:id — partial update, idempotent through optimistic
 * concurrency. The update only applies when the caller's `version` still
 * matches the stored one, so replaying the same PATCH is a no-op (the second
 * attempt reports STALE_RESOURCE rather than silently applying twice).
 */
export const updateBooking = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { version: bodyVersion, ...updates } = req.body;
  const version = resolveVersion(req, bodyVersion);

  const current = await Booking.findById(id).lean();
  if (!current) throw new AppError('NOT_FOUND', 'Booking not found.');

  // Merge incoming fields over the stored booking to validate the result.
  const nextStart = updates.startAt ? new Date(updates.startAt) : current.startAt;
  const nextEnd = updates.endAt ? new Date(updates.endAt) : current.endAt;
  const nextStatus = updates.status ?? current.status;

  assertMergedWindow(
    { startAt: nextStart, endAt: nextEnd },
    // Only forbid the past when the caller is actually moving the start time;
    // otherwise an in-progress booking could never have its notes edited.
    { enforceFuture: Boolean(updates.startAt) }
  );

  const $set = { ...updates };
  if (updates.startAt) $set.startAt = nextStart;
  if (updates.endAt) $set.endAt = nextEnd;

  // Anything that changes which slots are held must recompute them.
  if (updates.startAt || updates.endAt || updates.status || updates.resourceId) {
    $set.slotKeys = slotsForStatus(nextStatus, nextStart, nextEnd);
  }

  let updated;
  try {
    updated = await Booking.findOneAndUpdate(
      { _id: id, __v: version },
      { $set, $inc: { __v: 1 } },
      { new: true, runValidators: true }
    ).lean();
  } catch (err) {
    if (isDuplicateKeyError(err, SLOT_INDEX_NAME)) throw bookingConflict();
    throw err;
  }

  if (!updated) {
    // The document exists (fetched above) but the version moved on.
    throw new AppError(
      'STALE_RESOURCE',
      'This booking was changed by someone else since you loaded it. ' +
        'Reload it and reapply your changes.'
    );
  }

  res.set('ETag', `"${updated.__v}"`);
  res.json({ booking: serializeBooking(updated) });
});

/**
 * DELETE /api/bookings/:id — idempotent by construction.
 * Deleting an already-deleted booking is success, not 404: the caller's
 * desired end state (gone) holds either way. Always 204, never 500.
 */
export const deleteBooking = asyncHandler(async (req, res) => {
  await Booking.findByIdAndDelete(req.params.id);
  res.status(204).end();
});

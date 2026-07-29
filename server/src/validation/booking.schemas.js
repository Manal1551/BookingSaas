import { z } from 'zod';

/**
 * Zod schemas for the Booking API — THE single source of truth for validation.
 *
 * This module is imported by BOTH sides:
 *   - server: `middleware/validate.js` parses every request through it
 *   - client: via the `@shared/booking.schemas.js` Vite alias, so the create
 *     form validates with the exact same rules the server enforces
 *
 * Because of that it must stay dependency-free apart from `zod` — no Node
 * builtins, no mongoose, nothing that cannot run in a browser.
 *
 * Every object schema is `.strict()`: unknown keys are rejected rather than
 * silently dropped, so a typo'd field is a loud 400 instead of a silent no-op.
 */

// --- Business constants (exported so UI copy and tests never hard-code them) ---

/**
 * Bookings are quantised onto a 5-minute grid. This is what makes the
 * DB-level overlap constraint possible: each booking is expanded into the set
 * of grid slots it occupies, and a unique index rejects any two bookings that
 * share a slot. Requiring aligned inputs means the grid never reports a
 * conflict between two bookings that do not truly overlap.
 */
export const SLOT_MINUTES = 5;
export const MAX_DURATION_MINUTES = 8 * 60;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_PAGE_SIZE = 200;

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed'];
export const BOOKING_SORTS = ['startAt', '-startAt', 'createdAt', '-createdAt'];

export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

// --- Field primitives -------------------------------------------------------

const isoDateTime = (label) =>
  z
    .string({ required_error: `${label} is required` })
    .min(1, `${label} is required`)
    .datetime({ offset: true, message: `${label} must be an ISO 8601 datetime` });

/**
 * A resource is whatever the booking occupies — a room, a staff member, a
 * piece of equipment. Week 2 keeps it a free-form identifier rather than
 * introducing a Resource collection; it only has to be stable and URL-safe.
 */
export const resourceIdSchema = z
  .string({ required_error: 'Resource is required' })
  .trim()
  .min(1, 'Resource is required')
  .max(64, 'Resource must be 64 characters or fewer')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'Resource may contain only letters, numbers, dot, dash and underscore'
  );

/** UUID supplied in the `Idempotency-Key` header. Required on POST. */
export const idempotencyKeySchema = z
  .string({ required_error: 'An Idempotency-Key header is required' })
  .trim()
  .uuid('Idempotency-Key must be a UUID');

/** Mongo ObjectId, validated before it ever reaches the database. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'Must be a 24-character hex id');

/** Optimistic-concurrency token, from an `If-Match` header or a body field. */
export const versionSchema = z.coerce
  .number({ invalid_type_error: 'version must be a number' })
  .int('version must be an integer')
  .min(0, 'version must be zero or greater');

// --- Cross-field rules ------------------------------------------------------

/** True when `iso` lands exactly on the 5-minute grid (no stray secs/ms). */
export function isAlignedToSlotGrid(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0 &&
    d.getUTCMinutes() % SLOT_MINUTES === 0
  );
}

const issue = (ctx, path, message) =>
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

/**
 * The booking-window rules, in one place so create, update and the server-side
 * merged-update check can never drift apart.
 *
 * @param {{ startAt?: string, endAt?: string }} data
 * @param {import('zod').RefinementCtx} ctx
 * @param {{ enforceFuture?: boolean }} [opts] `enforceFuture` is off when
 *   re-validating an existing booking whose start time is not being moved.
 */
export function refineBookingWindow(data, ctx, { enforceFuture = true } = {}) {
  const { startAt, endAt } = data;

  if (startAt && !isAlignedToSlotGrid(startAt)) {
    issue(ctx, 'startAt', `Start must fall on a ${SLOT_MINUTES}-minute boundary`);
  }
  if (endAt && !isAlignedToSlotGrid(endAt)) {
    issue(ctx, 'endAt', `End must fall on a ${SLOT_MINUTES}-minute boundary`);
  }

  if (startAt && endAt) {
    const start = new Date(startAt).getTime();
    const end = new Date(endAt).getTime();
    if (Number.isFinite(start) && Number.isFinite(end)) {
      if (end <= start) {
        issue(ctx, 'endAt', 'End must be after start');
      } else if ((end - start) / 60_000 > MAX_DURATION_MINUTES) {
        issue(
          ctx,
          'endAt',
          `A booking may not run longer than ${MAX_DURATION_MINUTES / 60} hours`
        );
      }
    }
  }

  if (enforceFuture && startAt) {
    const start = new Date(startAt).getTime();
    if (Number.isFinite(start) && start < Date.now()) {
      issue(ctx, 'startAt', 'Must be in the future');
    }
  }
}

// --- Request schemas --------------------------------------------------------

const bookingFields = {
  customerName: z
    .string({ required_error: 'Customer name is required' })
    .trim()
    .min(1, 'Customer name is required')
    .max(120, 'Customer name must be 120 characters or fewer'),
  customerEmail: z
    .string({ required_error: 'Customer email is required' })
    .trim()
    .min(1, 'Customer email is required')
    .email('Enter a valid email address')
    .max(200, 'Customer email must be 200 characters or fewer'),
  serviceName: z
    .string({ required_error: 'Service is required' })
    .trim()
    .min(1, 'Service is required')
    .max(160, 'Service must be 160 characters or fewer'),
  resourceId: resourceIdSchema,
  startAt: isoDateTime('Start'),
  endAt: isoDateTime('End'),
  notes: z
    .string()
    .trim()
    .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`)
    .default(''),
  status: bookingStatusSchema.optional(),
};

/** POST /api/bookings body. */
export const createBookingInputSchema = z
  .object(bookingFields)
  .strict()
  .superRefine((data, ctx) => refineBookingWindow(data, ctx));

/**
 * PATCH /api/bookings/:id body — every field optional, but `version` is
 * required unless an `If-Match` header carries it (checked in the controller).
 *
 * `enforceFuture` is false here: the merged-window check in the controller
 * applies it only when `startAt` is actually being moved, so an in-progress or
 * past booking can still have its notes or status edited.
 */
export const updateBookingInputSchema = z
  .object({
    customerName: bookingFields.customerName.optional(),
    customerEmail: bookingFields.customerEmail.optional(),
    serviceName: bookingFields.serviceName.optional(),
    resourceId: resourceIdSchema.optional(),
    startAt: isoDateTime('Start').optional(),
    endAt: isoDateTime('End').optional(),
    notes: z
      .string()
      .trim()
      .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`)
      .optional(),
    status: bookingStatusSchema.optional(),
    version: versionSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const { version, ...fields } = data;
    if (Object.keys(fields).length === 0) {
      issue(ctx, 'version', 'Provide at least one field to update');
    }
    refineBookingWindow(data, ctx, { enforceFuture: false });
  });

/** GET /api/bookings query string. */
export const listBookingsQuerySchema = z
  .object({
    from: isoDateTime('From').optional(),
    to: isoDateTime('To').optional(),
    status: bookingStatusSchema.optional(),
    resourceId: resourceIdSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(100),
    sort: z.enum(BOOKING_SORTS).default('startAt'),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.from && data.to && new Date(data.to) <= new Date(data.from)) {
      issue(ctx, 'to', '`to` must be after `from`');
    }
  });

/** `:id` path parameter. */
export const bookingIdParamsSchema = z.object({ id: objectIdSchema }).strict();

/**
 * Type helpers, inferred rather than hand-written so the types can never drift
 * from the runtime rules.
 *
 * @typedef {import('zod').infer<typeof createBookingInputSchema>} CreateBookingInput
 * @typedef {import('zod').infer<typeof updateBookingInputSchema>} UpdateBookingInput
 * @typedef {import('zod').infer<typeof listBookingsQuerySchema>} ListBookingsQuery
 * @typedef {import('zod').infer<typeof bookingStatusSchema>} BookingStatus
 */

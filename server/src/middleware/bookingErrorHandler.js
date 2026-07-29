import { ZodError } from 'zod';
import { isProd } from '../config/env.js';
import { AppError, isDuplicateKeyError } from '../utils/appError.js';
import { HttpError } from '../utils/httpError.js';
import { zodIssuesToDetails } from '../utils/errorDetails.js';
import { SLOT_INDEX_NAME } from '../models/Booking.js';

/**
 * Router-scoped error handler for `/api/bookings/*`.
 *
 * Mounted on the bookings router rather than the app, so Week 1's global
 * `errorHandler` — and the flat `{ error: "message" }` shape that Login,
 * Register and Landing already parse — is left completely untouched.
 *
 * Every non-2xx booking response leaves through here, in exactly one shape:
 *
 *   { error: { code, message, details?, requestId } }
 */

// Week 1 middleware (resolveTenant, requireAuth) throws HttpError with a
// status. Map those onto the code union so auth failures on booking routes
// still speak the new envelope.
const STATUS_TO_CODE = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'BOOKING_CONFLICT',
  429: 'RATE_LIMITED',
};

/** @returns {AppError} */
function toAppError(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError(
      'VALIDATION_ERROR',
      'The request failed validation.',
      zodIssuesToDetails(err.issues, 'body')
    );
  }

  if (err instanceof HttpError) {
    const code = STATUS_TO_CODE[err.status] ?? 'INTERNAL_ERROR';
    return new AppError(
      code,
      code === 'INTERNAL_ERROR' ? 'An unexpected error occurred.' : err.message
    );
  }

  // A slot collision that escaped the controller's own catch.
  if (isDuplicateKeyError(err, SLOT_INDEX_NAME)) {
    return new AppError(
      'BOOKING_CONFLICT',
      'That resource is already booked for part of this time range.'
    );
  }

  // Mongoose cast failures are malformed input, not server faults.
  if (err?.name === 'CastError') {
    return new AppError('VALIDATION_ERROR', 'A value in the request was malformed.', [
      { path: `body.${err.path}`, message: 'Malformed value' },
    ]);
  }

  if (err?.name === 'ValidationError' && err?.errors) {
    return new AppError(
      'VALIDATION_ERROR',
      'The request failed validation.',
      Object.entries(err.errors).map(([path, e]) => ({
        path: `body.${path}`,
        message: e?.message ?? 'Invalid value',
      }))
    );
  }

  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
}

// eslint-disable-next-line no-unused-vars
export function bookingErrorHandler(err, req, res, _next) {
  const appErr = toAppError(err);

  if (appErr.status >= 500) {
    // Log the real cause server-side, keyed by requestId so a user's support
    // ticket can be traced. Nothing sensitive travels to the client.
    console.error(`[booking-error] ${req.id} ${err?.message ?? err}`);
    if (!isProd && err?.stack) console.error(err.stack);
  }

  const body = {
    error: {
      code: appErr.code,
      message: appErr.message,
      requestId: req.id,
    },
  };
  if (appErr.details?.length) body.error.details = appErr.details;

  res.status(appErr.status).json(body);
}

/** Catch-all for unmatched `/api/bookings/*` paths, in the same envelope. */
export function bookingNotFound(_req, _res, next) {
  next(new AppError('NOT_FOUND', 'No such booking endpoint.'));
}

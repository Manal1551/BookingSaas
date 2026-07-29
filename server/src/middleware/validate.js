import { AppError } from '../utils/appError.js';
import { zodIssuesToDetails } from '../utils/errorDetails.js';

/**
 * The single validation wrapper for the Booking API. Handlers contain no
 * ad-hoc `if (!body.x)` checks — if a value reached a handler, a schema
 * already vouched for it.
 *
 *   router.post('/', validate(createBookingInputSchema, 'body'), createBooking);
 *   router.get('/', validate(listBookingsQuerySchema, 'query'), listBookings);
 *
 * On success the parsed value (coerced, trimmed, defaulted) replaces
 * `req[source]`. On failure it throws VALIDATION_ERROR carrying one
 * `details[]` entry per issue, each path prefixed with its source so the
 * client can map it straight back onto a form field.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @param {'body'|'query'|'params'} [source]
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const parsed = schema.safeParse(req[source] ?? {});

    if (!parsed.success) {
      return next(
        new AppError(
          'VALIDATION_ERROR',
          'The request failed validation.',
          zodIssuesToDetails(parsed.error.issues, source)
        )
      );
    }

    // Express 5 exposes req.query as a getter-only property; assign through it
    // when possible and fall back to redefining so coerced defaults stick.
    try {
      req[source] = parsed.data;
    } catch {
      Object.defineProperty(req, source, {
        value: parsed.data,
        configurable: true,
        writable: true,
      });
    }
    return next();
  };
}

/**
 * Validates a single request header against a schema and returns the parsed
 * value. Used for `Idempotency-Key` and `If-Match`, which are part of the API
 * contract but do not live in body/query/params.
 *
 * @param {import('express').Request} req
 * @param {string} header
 * @param {import('zod').ZodTypeAny} schema
 */
export function validateHeader(req, header, schema) {
  const parsed = schema.safeParse(req.get(header));
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `The \`${header}\` header is missing or invalid.`,
      parsed.error.issues.map((i) => ({
        path: `headers.${header}`,
        message: i.message,
      }))
    );
  }
  return parsed.data;
}

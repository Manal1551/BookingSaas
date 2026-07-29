/**
 * Error vocabulary for the Booking API (Week 2).
 *
 * Week 1 routes keep their original flat `{ error: "message" }` shape — this
 * module powers the richer envelope used by `/api/bookings/*` only:
 *
 *   { error: { code, message, details[], requestId } }
 *
 * `ERROR_CODES` is the closed union of codes the API may emit, and
 * `ERROR_STATUS` is the single source of truth mapping each code to its HTTP
 * status. Handlers throw `AppError` with a code and never pick a status
 * themselves, so a code can never disagree with its status.
 */

/**
 * @typedef {'VALIDATION_ERROR'|'UNAUTHORIZED'|'FORBIDDEN'|'NOT_FOUND'
 *   |'BOOKING_CONFLICT'|'IDEMPOTENCY_KEY_REUSE'|'REQUEST_IN_PROGRESS'
 *   |'STALE_RESOURCE'|'RATE_LIMITED'|'INTERNAL_ERROR'} ErrorCode
 */

/** @type {Readonly<Record<ErrorCode, ErrorCode>>} */
export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  BOOKING_CONFLICT: 'BOOKING_CONFLICT',
  IDEMPOTENCY_KEY_REUSE: 'IDEMPOTENCY_KEY_REUSE',
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  STALE_RESOURCE: 'STALE_RESOURCE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** Central code -> HTTP status map. @type {Readonly<Record<ErrorCode, number>>} */
export const ERROR_STATUS = Object.freeze({
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BOOKING_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSE: 409,
  REQUEST_IN_PROGRESS: 409,
  STALE_RESOURCE: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

/**
 * @typedef {{ path: string, message: string }} ErrorDetail
 */

/**
 * An error carrying an API error code. The HTTP status is derived from the
 * code, never passed in.
 */
export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message human-readable summary (safe to show a user)
   * @param {ErrorDetail[]} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'AppError';
    /** @type {ErrorCode} */
    this.code = ERROR_CODES[code] ? code : 'INTERNAL_ERROR';
    /** @type {ErrorDetail[]|undefined} */
    this.details = details;
  }

  /** HTTP status for this error's code. */
  get status() {
    return ERROR_STATUS[this.code] ?? 500;
  }
}

/**
 * True when a Mongo write failed on a unique index. Optionally narrowed to a
 * specific index name so slot conflicts and idempotency-key races — which both
 * surface as E11000 — can be told apart.
 *
 * @param {unknown} err
 * @param {string} [indexName]
 */
export function isDuplicateKeyError(err, indexName) {
  if (!err || typeof err !== 'object') return false;
  if (/** @type {{ code?: number }} */ (err).code !== 11000) return false;
  if (!indexName) return true;
  const message = String(/** @type {{ message?: string }} */ (err).message ?? '');
  return message.includes(indexName);
}

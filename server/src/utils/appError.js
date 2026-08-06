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
 *   |'STALE_RESOURCE'|'RATE_LIMITED'|'INTERNAL_ERROR'
 *   |'BILLING_NOT_CONFIGURED'|'PLAN_UNAVAILABLE'|'NO_SUBSCRIPTION'
 *   |'PLAN_UNCHANGED'|'STRIPE_ERROR'|'PLAN_LIMIT_EXCEEDED'} ErrorCode
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

  // --- Week 3: billing ---------------------------------------------------
  /** This deployment has no Stripe keys — billing is switched off entirely. */
  BILLING_NOT_CONFIGURED: 'BILLING_NOT_CONFIGURED',
  /** The plan/interval exists in the catalog but has no Stripe price wired up. */
  PLAN_UNAVAILABLE: 'PLAN_UNAVAILABLE',
  /** An operation that needs an existing subscription found none. */
  NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
  /** Asked to switch to the plan the tenant is already on. */
  PLAN_UNCHANGED: 'PLAN_UNCHANGED',
  /** Stripe itself refused or was unreachable. */
  STRIPE_ERROR: 'STRIPE_ERROR',
  /** The request is valid but the tenant's plan has no room left for it. */
  PLAN_LIMIT_EXCEEDED: 'PLAN_LIMIT_EXCEEDED',
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

  // 503: billing is a dependency that is absent/*temporarily* unusable, not a
  // fault in the caller's request — the client should offer a retry, not a fix.
  BILLING_NOT_CONFIGURED: 503,
  PLAN_UNAVAILABLE: 409,
  NO_SUBSCRIPTION: 404,
  PLAN_UNCHANGED: 409,
  STRIPE_ERROR: 502,

  // 402 Payment Required — the one status HTTP reserved for exactly this, and
  // it is worth using: 403 would say "you may never do this", when the truth
  // is "upgrade and you may". Clients can branch on it to show an upsell
  // rather than an access-denied dead end.
  PLAN_LIMIT_EXCEEDED: 402,
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
